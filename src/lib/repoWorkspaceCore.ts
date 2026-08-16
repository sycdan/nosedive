import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isSeq, parseDocument, parse as parseYaml } from "yaml";

import {
	NosediveRc,
	formatPath,
	isInsideDir,
	resolveFrom,
	scalarToString,
	splitMarkdownFrontmatter,
	stringifyYaml,
	uuidLike,
} from "./coreParsing.js";
import { FeatRepo, KbDoc, parseFeatRepos, repoDocs } from "./kbDocs.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { writeFileAtomic } from "./renderPlan.js";

export function resolveRepoDoc(kbDocs: KbDoc[], repoRef: string): KbDoc {
	const repo = maybeResolveRepoDoc(kbDocs, repoRef);
	if (repo) return repo;
	throw new Error(`repo not found: ${repoRef}`);
}

export function maybeResolveRepoDoc(kbDocs: KbDoc[], repoRef: string): KbDoc | undefined {
	const byId = repoDocs(kbDocs).filter((doc) => doc.id === repoRef);
	if (byId.length === 1) return byId[0];

	const byName = repoDocs(kbDocs).filter((doc) => doc.name === repoRef);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(
			`repo name is ambiguous: ${repoRef} (${byName.map((doc) => doc.id).join(", ")})`,
		);
	}
	return undefined;
}

export function formatFeatRepoEntry(
	repoId: string,
	ref: string | undefined,
	readOnly: boolean,
): string {
	return `${repoId}${ref ? `@${ref}` : ""}${readOnly ? ":ro" : ""}`;
}

export function appendRepoToFeat(path: string, repo: FeatRepo): string {
	const existing = parseFeatRepos(path);
	if (existing.some((entry) => entry.id === repo.id))
		throw new Error(`feat already includes repo ${repo.id}: ${formatPath(path)}`);

	const text = readFileSync(path, "utf8");
	const label = formatPath(path);
	const frontmatter = splitMarkdownFrontmatter(text, label);
	const entry = formatFeatRepoEntry(repo.id, repo.ref, repo.readOnly);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0)
		throw new Error(
			`invalid YAML in frontmatter in ${label}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);

	const repos = doc.get("repos", true);
	if (repos === undefined || repos === null) {
		doc.set("repos", [entry]);
	} else if (isSeq(repos)) {
		repos.add(entry);
	} else {
		throw new Error(`invalid feat repos in ${label}: expected a YAML list`);
	}

	const yaml = stringifyYaml(doc);
	writeFileAtomic(path, ["---", yaml.trimEnd(), "---", frontmatter.body].join("\n"));
	return entry;
}

export interface HydrateRepoWorkspaceOptions {
	repoRef: string;
	at?: string;
	readOnly: boolean;
}

export interface DehydrateRepoWorkspaceOptions {
	repoRef: string;
	force: boolean;
}

export interface HydrateRepoWorkspaceResult {
	status: "created" | "updated" | "noop";
	repoId: string;
	targetPath: string;
	commit: string;
}

export interface DehydrateRepoWorkspaceResult {
	status: "removed" | "noop";
	repoId: string;
	targetPath: string;
}

export function parseHydrateRepoWorkspaceArgs(args: string[]): HydrateRepoWorkspaceOptions {
	let repoRef: string | undefined;
	let at: string | undefined;
	let readOnly = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--at") {
			const value = args[i + 1];
			if (!value) throw new Error("--at requires a value");
			at = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--at=")) {
			at = arg.slice("--at=".length);
			if (!at) throw new Error("--at requires a value");
			continue;
		}
		if (arg === "--read-only") {
			readOnly = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown hydrate-repo.workspace option: ${arg}`);
		if (repoRef) throw new Error(`unexpected hydrate-repo.workspace argument: ${arg}`);
		repoRef = arg;
	}

	if (!repoRef) throw new Error("hydrate-repo.workspace requires a repo id or name");
	return { repoRef, at, readOnly };
}

export function parseDehydrateRepoWorkspaceArgs(args: string[]): DehydrateRepoWorkspaceOptions {
	let repoRef: string | undefined;
	let force = false;

	for (const arg of args) {
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown dehydrate-repo.workspace option: ${arg}`);
		if (repoRef) throw new Error(`unexpected dehydrate-repo.workspace argument: ${arg}`);
		repoRef = arg;
	}

	if (!repoRef)
		throw new Error(
			"dehydrate-repo.workspace requires a repo id, name, or workspace-relative path",
		);
	return { repoRef, force };
}

export const MANAGED_CACHE_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

export function gitRun(cwd: string, args: string[], label: string): string {
	const result = runGit(cwd, args);
	if (result.status === 0) return result.stdout.trim();
	const detail = result.stderr.trim() || result.stdout.trim() || "unknown git error";
	throw new Error(`${label}: ${detail}`);
}

export function parseRepoMarkerStrict(markerPath: string): { id: string } {
	const raw = readFileSync(markerPath, "utf8");
	const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines.some((line) => /^\s/.test(line))) {
		throw new Error(
			`invalid marker format at ${formatPath(markerPath)}: no leading indentation is allowed`,
		);
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`invalid marker YAML at ${formatPath(markerPath)}: ${detail}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`invalid marker format at ${formatPath(markerPath)}: expected a YAML object`);
	}

	const obj = parsed as Record<string, unknown>;
	const keys = Object.keys(obj);
	if (keys.length !== 1 || keys[0] !== "id") {
		throw new Error(
			`invalid marker format at ${formatPath(markerPath)}: expected exactly one top-level key 'id'`,
		);
	}

	const idValue = scalarToString(obj.id)?.trim();
	if (!idValue || !uuidLike(idValue)) {
		throw new Error(`invalid marker format at ${formatPath(markerPath)}: id must be UUID-shaped`);
	}

	return { id: idValue };
}

export function realpathStable(path: string): string {
	if (existsSync(path)) return realpathSync(path);

	let current = resolve(path);
	const missingSegments: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		missingSegments.unshift(current.slice(parent.length).replace(/^[\\/]/, ""));
		current = parent;
	}

	const base = existsSync(current) ? realpathSync(current) : resolve(path);
	return missingSegments.reduce((acc, segment) => resolve(acc, segment), base);
}

export function ensureSafeTargetPath(
	repoId: string,
	targetPath: string,
	workspaceDir: string,
): void {
	const canonicalWorkspace = realpathStable(workspaceDir);
	const canonicalTarget = realpathStable(targetPath);
	if (!isInsideDir(canonicalWorkspace, canonicalTarget)) {
		throw new Error(
			`unsafe target path for repo ${repoId}: ${formatPath(targetPath)} resolves outside workspace ${formatPath(workspaceDir)}`,
		);
	}
}

export interface RepoRemotes {
	cloud?: string;
	local?: string;
}

export function repoRemotes(repoDoc: KbDoc): RepoRemotes {
	const remotes = repoDoc.metaRaw.remotes;
	if (!remotes || typeof remotes !== "object" || Array.isArray(remotes)) {
		throw new Error(
			`repo ${repoDoc.id} is missing usable meta.remotes.cloud or meta.remotes.local in ${repoDoc.relPath}`,
		);
	}

	const raw = remotes as Record<string, unknown>;
	const cloud = scalarToString(raw.cloud)?.trim();
	const local = scalarToString(raw.local)?.trim();
	if (!cloud && !local) {
		throw new Error(
			`repo ${repoDoc.id} is missing usable meta.remotes.cloud or meta.remotes.local in ${repoDoc.relPath}`,
		);
	}

	return { cloud, local };
}

export function remoteLooksLikeUrl(remote: string): boolean {
	return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote) || /^[^@\s]+@[^:\s]+:.+/.test(remote);
}

export function resolveRemoteForGit(remote: string, bridgeDir: string): string {
	return remoteLooksLikeUrl(remote) ? remote : resolveFrom(bridgeDir, remote);
}

export function ensureLocalSeedUsable(repoId: string, sourcePath: string): void {
	if (!existsSync(sourcePath)) {
		throw new Error(`repo ${repoId} local seed does not exist: ${formatPath(sourcePath)}`);
	}
	if (!statSync(sourcePath).isDirectory()) {
		throw new Error(`repo ${repoId} local seed is not a directory: ${formatPath(sourcePath)}`);
	}
	if (!gitOutput(sourcePath, ["rev-parse", "--git-dir"])) {
		throw new Error(`repo ${repoId} local seed is not a git repository: ${formatPath(sourcePath)}`);
	}
}

export function managedCachePath(repoId: string, bridgeDir: string): string {
	return join(bridgeDir, ".nosedive", "cache", repoId);
}

export function cacheRemoteValue(
	repoDoc: KbDoc,
	bridgeDir: string,
): { remote: string; sourceKind: "cloud" | "local" } {
	const remotes = repoRemotes(repoDoc);
	if (remotes.cloud)
		return { remote: resolveRemoteForGit(remotes.cloud, bridgeDir), sourceKind: "cloud" };
	if (!remotes.local) {
		throw new Error(
			`repo ${repoDoc.id} is missing usable meta.remotes.cloud or meta.remotes.local in ${repoDoc.relPath}`,
		);
	}

	const local = resolveRemoteForGit(remotes.local, bridgeDir);
	ensureLocalSeedUsable(repoDoc.id, local);
	return { remote: local, sourceKind: "local" };
}

export function ensureOriginRemote(cachePath: string, remote: string, repoId: string): void {
	const remotes = gitOutput(cachePath, ["remote"])?.split(/\r?\n/).filter(Boolean) ?? [];
	if (!remotes.includes("origin")) {
		gitRun(
			cachePath,
			["remote", "add", "origin", remote],
			`failed to configure cache remote for repo ${repoId}`,
		);
	} else {
		const current = gitOutput(cachePath, ["remote", "get-url", "origin"]);
		if (current !== remote) {
			gitRun(
				cachePath,
				["remote", "set-url", "origin", remote],
				`failed to configure cache remote for repo ${repoId}`,
			);
		}
	}

	const fetchRefspecs =
		gitOutput(cachePath, ["config", "--get-all", "remote.origin.fetch"])
			?.split(/\r?\n/)
			.filter(Boolean) ?? [];
	if (fetchRefspecs.length !== 1 || fetchRefspecs[0] !== MANAGED_CACHE_FETCH_REFSPEC) {
		gitRun(
			cachePath,
			["config", "--replace-all", "remote.origin.fetch", MANAGED_CACHE_FETCH_REFSPEC],
			`failed to configure cache fetch refspec for repo ${repoId}`,
		);
	}
}

export function ensureManagedRepoCache(repoDoc: KbDoc, bridgeDir: string): string {
	const cachePath = managedCachePath(repoDoc.id, bridgeDir);
	const { remote, sourceKind } = cacheRemoteValue(repoDoc, bridgeDir);

	if (!existsSync(cachePath)) {
		mkdirSync(dirname(cachePath), { recursive: true });
		gitRun(
			dirname(cachePath),
			["clone", "--bare", remote, cachePath],
			`failed to prepare managed cache for repo ${repoDoc.id} from meta.remotes.${sourceKind}=${remote}`,
		);
		ensureOriginRemote(cachePath, remote, repoDoc.id);
		return cachePath;
	}

	if (!statSync(cachePath).isDirectory()) {
		throw new Error(
			`repo ${repoDoc.id} managed cache is not a directory: ${formatPath(cachePath)}`,
		);
	}
	if (!gitOutput(cachePath, ["rev-parse", "--git-dir"])) {
		throw new Error(
			`repo ${repoDoc.id} managed cache is not a git repository: ${formatPath(cachePath)}`,
		);
	}

	ensureOriginRemote(cachePath, remote, repoDoc.id);
	return cachePath;
}
