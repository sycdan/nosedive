import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { isSeq, parseDocument } from "yaml";

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
import { gitOutput, runGit } from "./gitProcess.js";
import { loadKbDocs, repoDocs, type KbDoc } from "./kbDocs.js";
import { parseScopeRefs } from "./kbRefs.js";
import { quoteYamlString } from "./renderPlan.js";
import { remoteLooksLikeUrl, resolveRemoteForGit } from "./repoWorkspaceCore.js";
import { assertSlug, titleFromSlug } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

export interface RecordRepoOptions {
	source: string;
	name?: string;
	baseBranch?: string;
}

export interface RecordRepoPlan {
	id: string;
	name: string;
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

export function parseRecordRepoArgs(args: string[]): RecordRepoOptions {
	let source: string | undefined;
	let name: string | undefined;
	let baseBranch: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--name" || arg === "--base-branch") {
			const value = optionValue(args, i + 1, arg);
			if (arg === "--name") name = value;
			else baseBranch = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--name=")) {
			name = arg.slice("--name=".length);
			if (!name) throw new Error("--name requires a value");
			continue;
		}
		if (arg.startsWith("--base-branch=")) {
			baseBranch = arg.slice("--base-branch=".length);
			if (!baseBranch) throw new Error("--base-branch requires a value");
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown record.repo option: ${arg}`);
		if (source !== undefined) throw new Error(`unexpected record.repo argument: ${arg}`);
		source = arg;
	}

	if (!source?.trim()) throw new Error("record.repo requires a clone URL or local path");
	if (name !== undefined) assertSlug(name, "record.repo name");
	if (baseBranch !== undefined && !baseBranch.trim()) {
		throw new Error("--base-branch requires a value");
	}
	return { source: source.trim(), name, baseBranch: baseBranch?.trim() };
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

	const isRemote = remoteLooksLikeUrl(options.source);
	const localPath = isRemote ? undefined : resolve(cwd, options.source);
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
		cloud = options.source;
		inferredBranch = remoteHead(options.source, rc.bridgeDir);
	}

	const name = options.name ?? inferredRepoName(localPath ?? options.source);
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
		repoPath,
		repoContent: renderRepoDoc({ id, name, workspacePath, trunk: branch, cloud, local }),
		backlogPath,
		backlogContent: renderBacklogRepoScope(backlogBefore, backlogPath, id),
	};
}
