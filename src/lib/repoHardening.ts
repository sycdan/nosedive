import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { GIT_HOOK_NAMES, prepareCommitMsgHook, proxyHook } from "./commitProvenance.js";
import { formatPath, resolveFrom } from "./coreParsing.js";
import { KbDoc } from "./kbDocs.js";
import { gitOutput } from "./gitProcess.js";
import { gitOk, writeFileAtomic } from "./renderPlan.js";
import { gitRun } from "./repoWorkspaceCore.js";

export function worktreeConfigEnabled(targetPath: string): boolean {
	return gitOutput(targetPath, ["config", "--get", "extensions.worktreeConfig"]) === "true";
}

function commitProvenanceOptions(repoDoc: KbDoc): {
	feat: boolean;
	coAuthor: boolean;
} {
	const raw = repoDoc.metaRaw["commit-provenance"];
	const options = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	// `commit-provenance.effort` is the older spelling of the same opt-out, still
	// read so a repo doc a pilot already configured keeps working.
	const feat = options.feat ?? options.effort;
	return {
		feat: feat !== false,
		coAuthor: options["co-author"] !== false,
	};
}

/** Installs the provenance hook while chaining the repo's own hook. */
export function reconcilePrepareCommitMsgHook(
	targetPath: string,
	featId: string,
	diveId: string,
	repoDoc: KbDoc,
): void {
	const repoId = repoDoc.id;
	const gitDirRaw = gitOutput(targetPath, ["rev-parse", "--git-dir"]);
	if (!gitDirRaw) throw new Error(`failed to resolve git directory for repo ${repoId}`);
	const gitDir = resolveFrom(targetPath, gitDirRaw);
	const managedHooksPath = join(gitDir, "nosedive-hooks");
	const managedHookPath = join(managedHooksPath, "prepare-commit-msg");
	const originalHookRecordPath = join(managedHooksPath, "original-prepare-commit-msg");
	const configuredHooksPath = gitOutput(targetPath, ["config", "--get", "core.hooksPath"]);
	const configuredPath = configuredHooksPath
		? resolveFrom(targetPath, configuredHooksPath)
		: undefined;
	const managedConfigured = configuredPath && resolve(configuredPath) === resolve(managedHooksPath);
	let originalHookPath: string | undefined;

	if (!managedConfigured) {
		if (configuredPath) {
			originalHookPath = join(configuredPath, "prepare-commit-msg");
		} else {
			const effectiveHooksPathRaw = gitOutput(targetPath, ["rev-parse", "--git-path", "hooks"]);
			if (!effectiveHooksPathRaw)
				throw new Error(`failed to resolve hooks directory for repo ${repoId}`);
			originalHookPath = join(resolveFrom(targetPath, effectiveHooksPathRaw), "prepare-commit-msg");
		}
		if (!configuredPath && !existsSync(originalHookPath)) originalHookPath = undefined;
	} else {
		originalHookPath = existsSync(originalHookRecordPath)
			? readFileSync(originalHookRecordPath, "utf8").trim() || undefined
			: undefined;
	}

	const hook = prepareCommitMsgHook(
		featId,
		diveId,
		originalHookPath,
		commitProvenanceOptions(repoDoc),
	);
	if (!existsSync(managedHookPath) || readFileSync(managedHookPath, "utf8") !== hook) {
		mkdirSync(managedHooksPath, { recursive: true });
		writeFileAtomic(managedHookPath, hook);
		chmodSync(managedHookPath, 0o755);
	}
	if (originalHookPath) {
		const originalHooksPath = dirname(originalHookPath);
		for (const hookName of GIT_HOOK_NAMES) {
			if (hookName === "prepare-commit-msg") continue;
			const originalPath = join(originalHooksPath, hookName);
			const proxyPath = join(managedHooksPath, hookName);
			if (!existsSync(originalPath)) continue;
			const proxy = proxyHook(originalPath);
			if (existsSync(proxyPath) && readFileSync(proxyPath, "utf8") === proxy) continue;
			mkdirSync(managedHooksPath, { recursive: true });
			writeFileAtomic(proxyPath, proxy);
			chmodSync(proxyPath, 0o755);
		}
	}
	const originalHookRecord = originalHookPath ? `${originalHookPath}\n` : "";
	if (
		!existsSync(originalHookRecordPath) ||
		readFileSync(originalHookRecordPath, "utf8") !== originalHookRecord
	) {
		mkdirSync(managedHooksPath, { recursive: true });
		writeFileAtomic(originalHookRecordPath, originalHookRecord);
	}
	if (!managedConfigured) {
		gitRun(
			targetPath,
			["config", "--worktree", "core.hooksPath", managedHooksPath],
			`failed to configure commit provenance hook for repo ${repoId}`,
		);
	}

	/**
	 * Tooling run inside a worktree writes `core.hooksPath` to the *shared*
	 * repository config -- npm's `prepare` lifecycle does exactly this. The
	 * worktree override above outranks it here, but any sibling worktree
	 * without one silently inherits it, so clear it once the override is in
	 * place. Cleanup, not prevention: the next `npm ci` writes it again.
	 */
	gitOk(targetPath, ["config", "--unset-all", "core.hooksPath"]);
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

/**
 * Schemeless on purpose. Git resolves a push URL before it runs pre-push, so a
 * blocked push never reaches a hook that could explain itself -- the sentinel
 * is the whole message. A `scheme://` value surfaces only the scheme
 * (`protocol 'no_push' is not supported`); a bare one is echoed in full.
 *
 * Each names a package kb doc rather than spelling out advice, so the message
 * points at versioned documentation instead of prose that drifts: read-only
 * cites `hydrate-repo.workspace`, writable cites `land`. The `nosedive-render-`
 * prefix makes the error self-describing -- it is the command that prints the
 * doc, and package kb docs render outside a bridge.
 */
export const PUSH_BLOCKED_READ_ONLY = "nosedive-render-c4e93002-2925-58bd-9b70-d917017a9fc7";
export const PUSH_BLOCKED_LAND_ONLY = "nosedive-render-587d3f73-2534-5179-b111-ce6c83d6814d";

/** Sentinels written by earlier releases; worktrees on disk still carry them. */
const LEGACY_PUSH_BLOCKED_READ_ONLY = "no_push://disabled";
const LEGACY_PROSE_PUSH_BLOCKED_READ_ONLY = "nosedive-push-blocked--repo-is-read-only-in-this-dive";

/** Worktrees hydrated before the land-only sentinel existed still read as ro. */
export function isReadOnlyPushUrl(pushUrl: string | undefined): boolean {
	return (
		pushUrl === PUSH_BLOCKED_READ_ONLY ||
		pushUrl === LEGACY_PUSH_BLOCKED_READ_ONLY ||
		pushUrl === LEGACY_PROSE_PUSH_BLOCKED_READ_ONLY
	);
}

/**
 * Every hydrated worktree is push-isolated, writable ones included: `land`
 * publishes from the bridge by explicit URL, which a `pushurl` override does
 * not touch. The two sentinels differ so a writable worktree is still
 * distinguishable from a read-only one by config alone.
 */
export function reconcilePushIsolation(
	sourcePath: string,
	targetPath: string,
	readOnly: boolean,
	repoId: string,
): boolean {
	let changed = false;
	if (!worktreeConfigEnabled(sourcePath)) {
		gitRun(
			sourcePath,
			["config", "extensions.worktreeConfig", "true"],
			`failed to enable worktree-local config for repo ${repoId}`,
		);
		changed = true;
	}
	if (ensureLinkedWorktreesNonBare(sourcePath, repoId)) changed = true;

	const wanted = readOnly ? PUSH_BLOCKED_READ_ONLY : PUSH_BLOCKED_LAND_ONLY;
	const pushUrl = gitOutput(targetPath, ["config", "--worktree", "--get", "remote.origin.pushurl"]);
	if (pushUrl === wanted) return changed;

	gitRun(
		targetPath,
		["config", "--worktree", "--replace-all", "remote.origin.pushurl", wanted],
		`failed to enforce push isolation for repo ${repoId}`,
	);
	return true;
}
