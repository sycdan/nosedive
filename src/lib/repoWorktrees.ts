import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { isInsideDir } from "./backlogDives.js";
import { prepareCommitMsgHook } from "./commitProvenance.js";
import { formatPath, resolveFrom } from "./coreParsing.js";
import { REPO_MARKER_EXCLUDE_SPEC, replaceManagedExcludeBlock } from "./gitState.js";
import { KbDoc, repoDocs } from "./kbDocs.js";
import { gitOutput, writeFileAtomic } from "./renderPlan.js";
import {
	ensureSafeTargetPath,
	gitRun,
	parseRepoMarkerStrict,
	realpathStable,
	runGit,
} from "./repoWorkspaceCore.js";

export function expectedWorktreePath(repoDoc: KbDoc, bridgeDir: string): string {
	const worktreePath = repoDoc.repoPath ?? repoDoc.metaScalars["worktree-path"];
	if (!worktreePath) {
		throw new Error(
			`repo ${repoDoc.id} is missing meta.path and deprecated meta.worktree-path fallback in ${repoDoc.relPath}`,
		);
	}
	return resolveFrom(bridgeDir, worktreePath);
}

export function worktreeHasExpectedSource(targetPath: string, sourcePath: string): boolean {
	const sourceCommonRaw = gitOutput(sourcePath, ["rev-parse", "--git-common-dir"]);
	const targetCommonRaw = gitOutput(targetPath, ["rev-parse", "--git-common-dir"]);
	if (!sourceCommonRaw || !targetCommonRaw) return false;

	const sourceCommonPath = realpathStable(resolveFrom(sourcePath, sourceCommonRaw));
	const targetCommonPath = realpathStable(resolveFrom(targetPath, targetCommonRaw));
	return sourceCommonPath === targetCommonPath;
}

export function maybeFetchSource(sourcePath: string, repoId: string): void {
	const remotes = gitOutput(sourcePath, ["remote"]);
	if (!remotes) return;
	const fetched = runGit(sourcePath, ["fetch", "--all", "--prune"]);
	if (fetched.status !== 0) {
		const detail = fetched.stderr.trim() || fetched.stdout.trim() || "unknown git error";
		throw new Error(
			`failed to fetch managed cache for repo ${repoId} at ${formatPath(sourcePath)}: ${detail}`,
		);
	}
}

export function pruneStaleWorktrees(sourcePath: string, repoId: string): void {
	gitRun(
		sourcePath,
		["worktree", "prune"],
		`failed to prune stale worktrees for repo ${repoId} at ${formatPath(sourcePath)}`,
	);
}

export function resolveRefCommit(sourcePath: string, repoId: string, ref: string): string {
	maybeFetchSource(sourcePath, repoId);
	const remoteCommit = gitOutput(sourcePath, [
		"rev-parse",
		"--verify",
		`refs/remotes/origin/${ref}^{commit}`,
	]);
	if (remoteCommit) return remoteCommit;
	return gitRun(
		sourcePath,
		["rev-parse", "--verify", `${ref}^{commit}`],
		`failed to resolve ref for repo ${repoId}: ref=${ref}`,
	);
}

export function markerPathForTarget(targetPath: string): string {
	return join(targetPath, ".nosedive-ref");
}

export function isDirEmpty(path: string): boolean {
	return readdirSync(path).length === 0;
}

export function ensureReusableExistingTarget(
	repoId: string,
	targetPath: string,
	sourcePath: string,
): void {
	const markerPath = markerPathForTarget(targetPath);
	if (!existsSync(markerPath)) {
		throw new Error(
			`unsafe target path for repo ${repoId}: non-empty target is missing ${formatPath(markerPath)}`,
		);
	}

	const marker = parseRepoMarkerStrict(markerPath);
	if (marker.id !== repoId) {
		throw new Error(
			`marker mismatch for repo ${repoId} at ${formatPath(targetPath)}: expected id=${repoId}, found id=${marker.id}`,
		);
	}

	if (!gitOutput(targetPath, ["rev-parse", "--is-inside-work-tree"])) {
		throw new Error(
			`unsafe target path for repo ${repoId}: ${formatPath(targetPath)} is not a git worktree`,
		);
	}
	if (!worktreeHasExpectedSource(targetPath, sourcePath)) {
		throw new Error(
			`unsafe target path for repo ${repoId}: ${formatPath(targetPath)} is a git worktree for a different source repository`,
		);
	}
}

export function ensureDehydratePathInsideWorkspace(
	pathRef: string,
	bridgeDir: string,
	workspaceDir: string,
): string {
	if (isAbsolute(pathRef)) {
		throw new Error(
			`unsafe dehydrate target path: expected a workspace-relative path, got absolute path ${formatPath(pathRef)}`,
		);
	}

	const candidate = resolve(bridgeDir, pathRef);
	if (!isInsideDir(workspaceDir, candidate)) {
		throw new Error(
			`unsafe dehydrate target path: ${pathRef} resolves outside configured workspace ${formatPath(workspaceDir)}`,
		);
	}
	return candidate;
}

export function resolveDehydrateTargetFromPath(
	pathRef: string,
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string,
): { repoDoc: KbDoc; targetPath: string } {
	const resolved = ensureDehydratePathInsideWorkspace(pathRef, bridgeDir, workspaceDir);
	const markerPath = resolved.endsWith(".nosedive-ref")
		? resolved
		: join(resolved, ".nosedive-ref");
	if (!existsSync(markerPath)) {
		throw new Error(
			`unsafe dehydrate target path: expected managed marker at ${formatPath(markerPath)}`,
		);
	}
	if (!statSync(markerPath).isFile()) {
		throw new Error(
			`unsafe dehydrate target path: marker is not a file at ${formatPath(markerPath)}`,
		);
	}

	const marker = parseRepoMarkerStrict(markerPath);
	const repoDoc = repoDocs(kbDocs).find((doc) => doc.id === marker.id);
	if (!repoDoc) {
		throw new Error(`repo not found for marker id ${marker.id}: ${formatPath(markerPath)}`);
	}

	const targetPath = expectedWorktreePath(repoDoc, bridgeDir);
	ensureSafeTargetPath(repoDoc.id, targetPath, workspaceDir);

	const inputTargetPath = resolved.endsWith(".nosedive-ref") ? dirname(resolved) : resolved;
	if (realpathStable(inputTargetPath) !== realpathStable(targetPath)) {
		throw new Error(
			`unsafe dehydrate target path: ${formatPath(inputTargetPath)} does not match configured workspace target ${formatPath(targetPath)} for repo ${repoDoc.id}`,
		);
	}

	return { repoDoc, targetPath };
}

export function ensureDehydrateTargetOwnership(repoId: string, targetPath: string): void {
	if (!statSync(targetPath).isDirectory()) {
		throw new Error(
			`unsafe target path for repo ${repoId}: target exists but is not a directory: ${formatPath(targetPath)}`,
		);
	}

	const markerPath = markerPathForTarget(targetPath);
	if (!existsSync(markerPath)) {
		throw new Error(
			`unsafe target path for repo ${repoId}: target is missing managed marker ${formatPath(markerPath)}`,
		);
	}

	const marker = parseRepoMarkerStrict(markerPath);
	if (marker.id !== repoId) {
		throw new Error(
			`marker mismatch for repo ${repoId} at ${formatPath(targetPath)}: expected id=${repoId}, found id=${marker.id}`,
		);
	}

	if (!gitOutput(targetPath, ["rev-parse", "--is-inside-work-tree"])) {
		throw new Error(
			`unsafe target path for repo ${repoId}: ${formatPath(targetPath)} is not a git worktree`,
		);
	}
}

export function dehydrateHasUncommittedWork(targetPath: string): boolean {
	const status = gitOutput(targetPath, ["status", "--short"]);
	return Boolean(status && status.trim());
}

export function dehydrateHasUnpublishedCommits(targetPath: string): boolean {
	const refsContainingHeadRaw =
		gitOutput(targetPath, [
			"for-each-ref",
			"--format=%(refname)",
			"--contains",
			"HEAD",
			"refs/heads",
			"refs/remotes",
		]) ?? "";
	const refsContainingHead = refsContainingHeadRaw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const currentBranch = gitOutput(targetPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

	if (!currentBranch) return refsContainingHead.length === 0;

	const upstream = gitOutput(targetPath, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	if (upstream) {
		const aheadCount = gitRun(
			targetPath,
			["rev-list", "--count", `${upstream}..HEAD`],
			"failed to inspect unpublished commits",
		);
		return Number(aheadCount) > 0;
	}

	const currentHeadRef = `refs/heads/${currentBranch}`;
	const otherRefsContainHead = refsContainingHead.some((ref) => ref !== currentHeadRef);
	return !otherRefsContainHead;
}

export function removeHydratedWorktree(repoId: string, targetPath: string, force: boolean): void {
	const commonDirRaw = gitOutput(targetPath, ["rev-parse", "--git-common-dir"]);
	if (!commonDirRaw) {
		throw new Error(
			`failed to resolve worktree source for repo ${repoId} at ${formatPath(targetPath)}`,
		);
	}
	const sourcePath = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(targetPath, commonDirRaw);

	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(targetPath);
	gitRun(
		sourcePath,
		args,
		`failed to remove hydrated worktree for repo ${repoId} at ${formatPath(targetPath)}`,
	);
}

export function ensureDetachedAtCommit(
	targetPath: string,
	commit: string,
	repoId: string,
	discardLocalChanges = false,
): boolean {
	const currentCommit = gitRun(
		targetPath,
		["rev-parse", "HEAD"],
		`failed to inspect current commit for repo ${repoId}`,
	);
	const symbolicHead = gitOutput(targetPath, ["symbolic-ref", "-q", "HEAD"]);
	if (currentCommit === commit && !symbolicHead) return false;

	const args = ["checkout", "--detach"];
	if (discardLocalChanges) args.push("--force");
	args.push(commit);
	gitRun(
		targetPath,
		args,
		`failed to detach worktree for repo ${repoId} at ${formatPath(targetPath)}`,
	);
	return true;
}

export function writeRepoMarker(targetPath: string, repoId: string): boolean {
	const markerPath = markerPathForTarget(targetPath);
	const expected = `id: ${repoId}\n`;
	const existing = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined;
	if (existing === expected) return false;
	writeFileAtomic(markerPath, expected);
	return true;
}

export function ensureRepoMarkerExcluded(targetPath: string, repoId: string): boolean {
	const rawExcludePath = gitOutput(targetPath, ["rev-parse", "--git-path", "info/exclude"]);
	if (!rawExcludePath) {
		throw new Error(
			`failed to resolve git exclude path for repo ${repoId} at ${formatPath(targetPath)}`,
		);
	}

	const excludePath = isAbsolute(rawExcludePath)
		? rawExcludePath
		: resolve(targetPath, rawExcludePath);
	const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	const updated = replaceManagedExcludeBlock(existing, [".nosedive-ref"], REPO_MARKER_EXCLUDE_SPEC);
	if (updated === existing) return false;

	writeFileAtomic(excludePath, updated);
	return true;
}

export function worktreeConfigEnabled(targetPath: string): boolean {
	return gitOutput(targetPath, ["config", "--get", "extensions.worktreeConfig"]) === "true";
}

export interface PrepareCommitMsgHookResult {
	changed: boolean;
	foreignHookPath?: string;
}

/** Installs the provenance hook without replacing an existing hook setup. */
export function reconcilePrepareCommitMsgHook(
	targetPath: string,
	effortId: string,
	repoId: string,
): PrepareCommitMsgHookResult {
	const gitDirRaw = gitOutput(targetPath, ["rev-parse", "--git-dir"]);
	if (!gitDirRaw) throw new Error(`failed to resolve git directory for repo ${repoId}`);
	const gitDir = resolveFrom(targetPath, gitDirRaw);
	const managedHooksPath = join(gitDir, "nosedive-hooks");
	const managedHookPath = join(managedHooksPath, "prepare-commit-msg");
	const configuredHooksPath = gitOutput(targetPath, ["config", "--get", "core.hooksPath"]);

	if (configuredHooksPath) {
		const configuredPath = resolveFrom(targetPath, configuredHooksPath);
		const configuredHookPath = join(configuredPath, "prepare-commit-msg");
		const managed =
			resolve(configuredPath) === resolve(managedHooksPath) &&
			existsSync(configuredHookPath) &&
			readFileSync(configuredHookPath, "utf8").includes("nosedive-managed prepare-commit-msg");
		if (!managed) return { changed: false, foreignHookPath: configuredHookPath };
	} else {
		const effectiveHooksPathRaw = gitOutput(targetPath, ["rev-parse", "--git-path", "hooks"]);
		if (!effectiveHooksPathRaw)
			throw new Error(`failed to resolve hooks directory for repo ${repoId}`);
		const existingHookPath = join(
			resolveFrom(targetPath, effectiveHooksPathRaw),
			"prepare-commit-msg",
		);
		if (existsSync(existingHookPath)) {
			return { changed: false, foreignHookPath: existingHookPath };
		}
	}

	const hook = prepareCommitMsgHook(effortId);
	let changed = false;
	if (!existsSync(managedHookPath) || readFileSync(managedHookPath, "utf8") !== hook) {
		mkdirSync(managedHooksPath, { recursive: true });
		writeFileAtomic(managedHookPath, hook);
		chmodSync(managedHookPath, 0o755);
		changed = true;
	}
	if (!configuredHooksPath) {
		gitRun(
			targetPath,
			["config", "--worktree", "core.hooksPath", managedHooksPath],
			`failed to configure commit provenance hook for repo ${repoId}`,
		);
		changed = true;
	}
	return { changed };
}

export interface GitWorktreeEntry {
	path: string;
	bare: boolean;
}

export function gitWorktreeEntries(sourcePath: string, repoId: string): GitWorktreeEntry[] {
	const text = gitRun(
		sourcePath,
		["worktree", "list", "--porcelain"],
		`failed to list worktrees for repo ${repoId} at ${formatPath(sourcePath)}`,
	);
	const entries: GitWorktreeEntry[] = [];
	let current: GitWorktreeEntry | undefined;

	for (const line of text.split(/\r?\n/)) {
		if (!line) {
			if (current) entries.push(current);
			current = undefined;
			continue;
		}
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length), bare: false };
			continue;
		}
		if (line === "bare" && current) current.bare = true;
	}
	if (current) entries.push(current);
	return entries;
}

export function ensureLinkedWorktreesNonBare(sourcePath: string, repoId: string): boolean {
	let changed = false;
	for (const entry of gitWorktreeEntries(sourcePath, repoId)) {
		if (entry.bare || !existsSync(entry.path)) continue;
		const current = gitOutput(entry.path, ["config", "--worktree", "--get", "core.bare"]);
		if (current === "false") continue;
		gitRun(
			entry.path,
			["config", "--worktree", "core.bare", "false"],
			`failed to mark linked worktree non-bare for repo ${repoId} at ${formatPath(entry.path)}`,
		);
		changed = true;
	}
	return changed;
}

export function reconcilePushReadOnly(
	sourcePath: string,
	targetPath: string,
	readOnly: boolean,
	repoId: string,
): boolean {
	let changed = false;
	if (!worktreeConfigEnabled(sourcePath)) {
		if (!readOnly) return false;
		gitRun(
			sourcePath,
			["config", "extensions.worktreeConfig", "true"],
			`failed to enable worktree-local config for repo ${repoId}`,
		);
		changed = true;
	}
	if (ensureLinkedWorktreesNonBare(sourcePath, repoId)) changed = true;

	const pushUrl = gitOutput(targetPath, ["config", "--worktree", "--get", "remote.origin.pushurl"]);

	if (readOnly) {
		if (pushUrl === "no_push://disabled") return changed;
		gitRun(
			targetPath,
			["config", "--worktree", "--replace-all", "remote.origin.pushurl", "no_push://disabled"],
			`failed to enforce read-only push hardening for repo ${repoId}`,
		);
		return true;
	}

	if (!pushUrl) return changed;

	gitRun(
		targetPath,
		["config", "--worktree", "--unset-all", "remote.origin.pushurl"],
		`failed to clear worktree-local push URL override for repo ${repoId}`,
	);
	return true;
}

export interface ProveOptions {
	assertionRef: string;
	record: boolean;
	rehydrate: boolean;
	force: boolean;
	verbose: boolean;
}
