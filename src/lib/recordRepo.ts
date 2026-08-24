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
	url?: string;
	name?: string;
	baseBranch?: string;
	/** The URL arrived as a positional, in the spelling this level deprecates. */
	positionalUrl: boolean;
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
	const options: RecordRepoOptions = { positionalUrl: false };

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		const flag = ["--url", "--name", "--base-branch"].find(
			(candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
		);
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown record.repo option: ${arg}`);
			if (isDocRef(arg)) {
				if (options.ref !== undefined) throw new Error(`unexpected record.repo argument: ${arg}`);
				options.ref = arg;
			} else {
				if (options.url !== undefined) throw new Error(`record.repo url given twice: ${arg}`);
				options.url = arg;
				options.positionalUrl = true;
			}
			continue;
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value.trim()) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		if (flag === "--url") {
			if (options.url !== undefined) throw new Error("record.repo url given twice");
			options.url = value;
		} else if (flag === "--name") options.name = assertSlug(value, "record.repo name");
		else options.baseBranch = value.trim();
	}

	options.url = options.url?.trim();
	if (options.ref === undefined) {
		if (!options.url) throw new Error("record.repo requires --url <clone-url-or-local-path>");
	} else if (
		options.url === undefined &&
		options.name === undefined &&
		options.baseBranch === undefined
	) {
		throw new Error(`record.repo ${options.ref} names a repo but changes nothing about it`);
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

	const isRemote = remoteLooksLikeUrl(options.url!);
	const localPath = isRemote ? undefined : resolve(cwd, options.url!);
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
		cloud = options.url!;
		inferredBranch = remoteHead(options.url!, rc.bridgeDir);
	}

	const name = options.name ?? inferredRepoName(localPath ?? options.url!);
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
		repoContent: renderRepoDoc({ id, name, workspacePath, trunk: branch, cloud, local }),
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
	const remote = options.url ? remoteFor(options.url, rc) : undefined;
	// A trunk that cannot be inferred is a create-time refusal, not an edit one:
	// the doc already names one, and `--url` on its own is not a request to
	// change it. Inferring silently would move the trunk nobody asked to move.
	const trunk = options.baseBranch;

	editKbDoc(repo.path, (doc, body) => {
		if (options.name) doc.set("name", options.name);
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
	if (remote) io.log(`Set meta.remotes.${remote.key}`);
	if (trunk) io.log(`Set meta.trunk to ${trunk}`);
	io.log(`Updated ${formatPath(repo.path)}`);
	commitBridgeDocs(rc.bridgeDir, `repo(${name}): updated`, [repo.path], io);
}

export function recordRepo(args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("record.repo requires a configured kb directory");
	// Before the parse, because whether the positional is a document is a
	// question only the bridge can answer -- and a clone URL and a kb path are
	// the same shape.
	const kbDocs = existsSync(rc.kbDir) ? loadKbDocs(rc.kbDir, rc.bridgeDir) : [];
	const options = parseRecordRepoArgs(args, bridgeDocRefPredicate(rc.bridgeDir, kbDocs));
	if (options.positionalUrl) io.err(positionalGistNotice("record.repo", "--url"));
	if (options.ref === undefined) createRepo(options, io);
	else editRepo(rc, kbDocs, options, io);
}
