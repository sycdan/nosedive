import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isSeq, parseDocument } from "yaml";

import { CommandIo } from "./bridgeSetupIo.js";
import { commitBridgeDocs } from "./commitBridgeDocs.js";
import {
	formatPath,
	gitRelPath,
	isInsideDir,
	parseMarkdownDoc,
	readNosediveRc,
	splitMarkdownFrontmatter,
	stringifyYaml,
	toPosixPath,
	type NosediveRc,
} from "./coreParsing.js";
import { resolveBridgeDocRef } from "./diveScopes.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { editKbDoc } from "./kbDocEdit.js";
import { loadKbDocs, repoDocs, retitleGeneratedHeading, type KbDoc } from "./kbDocs.js";
import { parseScopeRefs } from "./kbRefs.js";
import { bridgeDocRefPredicate, positionalGistNotice } from "./recordArgs.js";
import { quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import { remoteLooksLikeUrl, resolveRemoteForGit } from "./repoWorkspaceCore.js";
import { assertSlug, titleFromSlug } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

export interface RecordRepoOptions {
	/** The repo doc to patch. Absent means register a new repository. */
	ref?: string;
	/** The clone URL or local path the repository is reached at. */
	remote?: string;
	/** The human-facing repository page, written to `meta.url`. Never derived. */
	page?: string;
	name?: string;
	baseBranch?: string;
	/** The remote arrived as a positional, in the spelling this level deprecates. */
	positionalRemote: boolean;
	/** `--url` supplied the remote, in the spelling this level deprecates. */
	urlAsRemote: boolean;
	/** `--url` was read as the page on a patch, where it once meant the remote. */
	urlAsPageOnEdit: boolean;
}

/**
 * A page is somewhere a person opens in a browser, so only http(s) can be one.
 * An ssh remote or a local path reaching `--url` means the caller wanted
 * `--remote` under its old name, and saying so beats writing an unopenable
 * `meta.url`.
 */
function looksLikePage(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

export interface RecordRepoPlan {
	id: string;
	name: string;
	bridgeDir: string;
	repoPath: string;
	repoContent: string;
	backlogPath: string;
	backlogContent: string;
}

function optionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseRecordRepoArgs(
	args: string[],
	isDocRef: (arg: string) => boolean,
): RecordRepoOptions {
	const options: RecordRepoOptions = {
		positionalRemote: false,
		urlAsRemote: false,
		urlAsPageOnEdit: false,
	};
	// `--url` is held apart until the whole call is known, because what it means
	// depends on whether a remote arrived some other way and on whether this is
	// a create or a patch.
	let url: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		const flag = ["--remote", "--url", "--name", "--base-branch"].find(
			(candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
		);
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown record.repo option: ${arg}`);
			if (isDocRef(arg)) {
				if (options.ref !== undefined) throw new Error(`unexpected record.repo argument: ${arg}`);
				options.ref = arg;
			} else {
				if (options.remote !== undefined) throw new Error(`record.repo remote given twice: ${arg}`);
				options.remote = arg;
				options.positionalRemote = true;
			}
			continue;
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value.trim()) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		if (flag === "--remote") {
			if (options.remote !== undefined) throw new Error("record.repo remote given twice");
			options.remote = value;
		} else if (flag === "--url") {
			if (url !== undefined) throw new Error("record.repo url given twice");
			url = value;
		} else if (flag === "--name") options.name = assertSlug(value, "record.repo name");
		else options.baseBranch = value.trim();
	}

	options.remote = options.remote?.trim();
	url = url?.trim();

	if (url) {
		if (options.ref === undefined && options.remote === undefined) {
			// Nothing else named a source and a create has to have one, so this is
			// the retired spelling. Reading it as the remote keeps every call
			// written before the rename working exactly as it did.
			options.remote = url;
			options.urlAsRemote = true;
		} else {
			if (!looksLikePage(url)) {
				throw new Error(
					`--url records the human-facing repository page and must be an http(s) URL: ${url}. ` +
						"Pass --remote <clone-url-or-local-path> to set the clone source.",
				);
			}
			options.page = url;
			options.urlAsPageOnEdit = options.ref !== undefined;
		}
	}

	if (options.ref === undefined && !options.remote) {
		throw new Error("record.repo requires --remote <clone-url-or-local-path>");
	}
	return options;
}

function sourceLeaf(source: string): string {
	const normalized = source.replace(/[\\/]+$/, "");
	const leaf = normalized.slice(
		Math.max(
			normalized.lastIndexOf("/"),
			normalized.lastIndexOf("\\"),
			normalized.lastIndexOf(":"),
		) + 1,
	);
	return leaf.replace(/\.git$/i, "");
}

function inferredRepoName(source: string): string {
	const slug = sourceLeaf(source)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) throw new Error("could not infer a repo name; pass --name <slug>");
	return assertSlug(slug, "record.repo name");
}

function remoteHead(remote: string, cwd: string): string | undefined {
	const result = runGit(cwd, ["ls-remote", "--symref", remote, "HEAD"]);
	if (result.status !== 0) {
		const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
		throw new Error(`cannot read repository ${remote}: ${detail || "git ls-remote failed"}`);
	}
	return /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m.exec(result.stdout)?.[1];
}

export function localTrunk(path: string): string | undefined {
	const originHead = gitOutput(path, [
		"symbolic-ref",
		"--quiet",
		"--short",
		"refs/remotes/origin/HEAD",
	]);
	if (originHead?.startsWith("origin/")) return originHead.slice("origin/".length);
	return gitOutput(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

export function portableLocalPath(path: string, bridgeDir: string): string {
	if (resolve(path) === resolve(bridgeDir)) return ".";
	if (isInsideDir(bridgeDir, path)) return gitRelPath(bridgeDir, path);
	const userHome = resolve(homedir());
	if (isInsideDir(userHome, path)) return `~/${toPosixPath(relative(userHome, path))}`;
	return toPosixPath(path);
}

function repoRemoteValues(repo: KbDoc): string[] {
	const remotes = repo.metaRaw.remotes;
	if (!remotes || typeof remotes !== "object" || Array.isArray(remotes)) return [];
	return Object.values(remotes)
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean);
}

function sameRemote(a: string, b: string, bridgeDir: string): boolean {
	if (remoteLooksLikeUrl(a) || remoteLooksLikeUrl(b)) {
		const normalized = (value: string): string =>
			value.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
		return normalized(a) === normalized(b);
	}
	return resolveRemoteForGit(a, bridgeDir) === resolveRemoteForGit(b, bridgeDir);
}

export function renderRepoDoc(options: {
	id: string;
	name: string;
	workspacePath: string;
	trunk: string;
	/** The human-facing repository page. Omitted entirely when absent. */
	url?: string;
	cloud?: string;
	local?: string;
	/** What minted the doc. `seed` mints one too, and a doc that names the wrong command is drift. */
	registeredBy?: string;
}): string {
	const remotes = [
		options.cloud ? `    cloud: ${quoteYamlString(options.cloud)}` : undefined,
		options.local ? `    local: ${quoteYamlString(options.local)}` : undefined,
	].filter((line): line is string => line !== undefined);
	return [
		"---",
		"kind: repo",
		`id: ${options.id}`,
		`name: ${options.name}`,
		`gist: ${quoteYamlString(`Repository registered as ${options.name}.`)}`,
		"meta:",
		`  path: ${quoteYamlString(options.workspacePath)}`,
		...(options.url ? [`  url: ${quoteYamlString(options.url)}`] : []),
		`  trunk: ${quoteYamlString(options.trunk)}`,
		"  remotes:",
		...remotes,
		"---",
		"",
		`# ${titleFromSlug(options.name)}`,
		"",
		`Registered by \`nosedive ${options.registeredBy ?? "record.repo"}\`. Run \`nosedive scan\` when this repository needs a sourced workload and quality-gate brief.`,
		"",
	].join("\n");
}

export function renderBacklogRepoScope(text: string, path: string, repoId: string): string {
	const label = formatPath(path);
	const frontmatter = splitMarkdownFrontmatter(text, label);
	const parsed = parseMarkdownDoc(text, label);
	if (parsed.fm.scalars.kind !== "memo") {
		throw new Error(`configured backlog is not kind: memo: ${label}`);
	}
	if (parseScopeRefs(parsed.fm.raw.scopes, path).some((scope) => scope.repoId === repoId)) {
		return text;
	}

	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0) {
		throw new Error(
			`invalid YAML in frontmatter in ${label}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);
	}
	const scopes = doc.get("scopes", true);
	if (scopes === undefined || scopes === null) doc.set("scopes", [repoId]);
	else if (isSeq(scopes)) scopes.add(repoId);
	else throw new Error(`invalid scopes in ${label}: expected a YAML list`);
	return ["---", stringifyYaml(doc).trimEnd(), "---", frontmatter.body].join("\n");
}

function configuredBacklogPath(rc: NosediveRc): string {
	if (!rc.kbDir) throw new Error("record.repo requires a configured kb directory");
	if (!rc.backlog) throw new Error("record.repo requires a configured backlog memo id");
	const path = join(rc.kbDir, `${rc.backlog}.md`);
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`bridge backlog memo not found: ${rc.backlog}`);
	}
	return path;
}

export function planRecordRepo(options: RecordRepoOptions, cwd = process.cwd()): RecordRepoPlan {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("record.repo requires a configured kb directory");
	if (!rc.workspaceDir) throw new Error("record.repo requires a configured workspace directory");

	const isRemote = remoteLooksLikeUrl(options.remote!);
	const localPath = isRemote ? undefined : resolve(cwd, options.remote!);
	let cloud: string | undefined;
	let local: string | undefined;
	let inferredBranch: string | undefined;

	if (localPath) {
		if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
			throw new Error(
				`local repo path does not exist or is not a directory: ${formatPath(localPath)}`,
			);
		}
		if (!gitOutput(localPath, ["rev-parse", "--git-dir"])) {
			throw new Error(`local repo path is not a git repository: ${formatPath(localPath)}`);
		}
		local = portableLocalPath(localPath, rc.bridgeDir);
		inferredBranch = localTrunk(localPath);
		const origin = gitOutput(localPath, ["remote", "get-url", "origin"]);
		if (origin && remoteLooksLikeUrl(origin)) cloud = origin;
	} else {
		cloud = options.remote!;
		inferredBranch = remoteHead(options.remote!, rc.bridgeDir);
	}

	const name = options.name ?? inferredRepoName(localPath ?? options.remote!);
	const branch = options.baseBranch ?? inferredBranch;
	if (!branch) {
		throw new Error(
			"could not determine the repository's base branch; pass --base-branch <branch>",
		);
	}

	const docs = existsSync(rc.kbDir) ? loadKbDocs(rc.kbDir, rc.bridgeDir) : [];
	const duplicateName = repoDocs(docs).find((repo) => repo.name === name);
	if (duplicateName)
		throw new Error(`repo name is already registered: ${name} (${duplicateName.id})`);
	for (const repo of repoDocs(docs)) {
		for (const candidate of [cloud, local].filter(
			(value): value is string => value !== undefined,
		)) {
			if (repoRemoteValues(repo).some((remote) => sameRemote(remote, candidate, rc.bridgeDir))) {
				throw new Error(`repository is already registered as ${repo.name} (${repo.id})`);
			}
		}
	}

	const id = uuid7AtMs(Date.now());
	const repoPath = join(rc.kbDir, `${id}.md`);
	const workspacePath = toPosixPath(relative(rc.bridgeDir, join(rc.workspaceDir, name)));
	const backlogPath = configuredBacklogPath(rc);
	const backlogBefore = readFileSync(backlogPath, "utf8");
	return {
		id,
		name,
		bridgeDir: rc.bridgeDir,
		repoPath,
		repoContent: renderRepoDoc({
			id,
			name,
			workspacePath,
			trunk: branch,
			url: options.page,
			cloud,
			local,
		}),
		backlogPath,
		backlogContent: renderBacklogRepoScope(backlogBefore, backlogPath, id),
	};
}
/**
 * `record.repo` writes two ways. Registering a repository is a plan the
 * caller applies -- `seed` mints a repo doc through the same renderer -- and
 * changing one is a patch that touches only the doc.
 */
function createRepo(options: RecordRepoOptions, io: CommandIo): void {
	const plan = planRecordRepo(options);
	writeFileAtomic(plan.repoPath, plan.repoContent);
	try {
		writeFileAtomic(plan.backlogPath, plan.backlogContent);
	} catch (error) {
		if (existsSync(plan.repoPath)) unlinkSync(plan.repoPath);
		throw error;
	}
	io.log(`Recorded ${formatPath(plan.repoPath)}`);
	io.log(`Added ${plan.name} to backlog scopes in ${formatPath(plan.backlogPath)}`);
	commitBridgeDocs(
		plan.bridgeDir,
		`repo(${plan.name}): created`,
		[plan.repoPath, plan.backlogPath],
		io,
	);
}

/**
 * Where a repository is reached, read off what `--url` was given. A local path
 * is checked for being a git repository here rather than trusted, because a
 * repo doc naming a directory that is not one hands every later hydrate a
 * failure with no explanation attached.
 */
function remoteFor(url: string, rc: NosediveRc): { key: "cloud" | "local"; value: string } {
	if (remoteLooksLikeUrl(url)) return { key: "cloud", value: url };
	const path = resolve(process.cwd(), url);
	if (!existsSync(path) || !statSync(path).isDirectory())
		throw new Error(`local repo path does not exist or is not a directory: ${formatPath(path)}`);
	if (!gitOutput(path, ["rev-parse", "--git-dir"]))
		throw new Error(`local repo path is not a git repository: ${formatPath(path)}`);
	return { key: "local", value: portableLocalPath(path, rc.bridgeDir) };
}

function editRepo(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	options: RecordRepoOptions,
	io: CommandIo,
): void {
	const repo = resolveBridgeDocRef(rc.bridgeDir, kbDocs, options.ref!);
	if (repo.kind !== "repo") throw new Error(`does not resolve to a kind: repo doc: ${options.ref}`);
	if (options.name) {
		const clash = repoDocs(kbDocs).find((doc) => doc.name === options.name && doc.id !== repo.id);
		if (clash) throw new Error(`repo name is already registered: ${options.name} (${clash.id})`);
	}
	const remote = options.remote ? remoteFor(options.remote, rc) : undefined;
	// A trunk that cannot be inferred is a create-time refusal, not an edit one:
	// the doc already names one, and `--remote` on its own is not a request to
	// change it. Inferring silently would move the trunk nobody asked to move.
	const trunk = options.baseBranch;

	editKbDoc(repo.path, (doc, body) => {
		if (options.name) doc.set("name", options.name);
		if (options.page) doc.setIn(["meta", "url"], options.page);
		if (trunk) doc.setIn(["meta", "trunk"], trunk);
		if (remote) doc.setIn(["meta", "remotes", remote.key], remote.value);
		return options.name ? retitleGeneratedHeading(body, repo.name, options.name) : body;
	});

	const name = options.name ?? repo.name;
	if (options.name) {
		// `meta.path` is left alone deliberately. It names a directory that may
		// already be hydrated, and a rename is about how the pilot addresses the
		// repository, not about moving a checkout out from under them.
		io.log(`Renamed to ${name}; its workspace path is unchanged`);
	}
	if (options.page) io.log(`Set meta.url to ${options.page}`);
	if (remote) io.log(`Set meta.remotes.${remote.key}`);
	if (trunk) io.log(`Set meta.trunk to ${trunk}`);
	const committed = commitBridgeDocs(rc.bridgeDir, `repo(${name}): updated`, [repo.path], io);
	io.log(
		committed ? `Updated ${formatPath(repo.path)}` : `Already published: ${formatPath(repo.path)}`,
	);
}

export function recordRepo(args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("record.repo requires a configured kb directory");
	// Before the parse, because whether the positional is a document is a
	// question only the bridge can answer -- and a clone URL and a kb path are
	// the same shape.
	const kbDocs = existsSync(rc.kbDir) ? loadKbDocs(rc.kbDir, rc.bridgeDir) : [];
	const options = parseRecordRepoArgs(args, bridgeDocRefPredicate(rc.bridgeDir, kbDocs));
	if (options.positionalRemote) io.err(positionalGistNotice("record.repo", "--remote"));
	if (options.urlAsRemote) {
		io.err(
			"record.repo: --url now records the human-facing repository page. " +
				"It was read as the clone source here because nothing else named one -- pass --remote instead.",
		);
	}
	if (options.urlAsPageOnEdit) {
		io.err(
			"record.repo: --url sets meta.url, the human-facing repository page. " +
				"Before this it set a meta.remotes entry -- pass --remote to change the clone source.",
		);
	}
	if (options.ref === undefined) createRepo(options, io);
	else editRepo(rc, kbDocs, options, io);
}
