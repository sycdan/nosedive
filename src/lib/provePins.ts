import { formatPath } from "./coreParsing.js";
import { ScopeRef } from "./kbDocs.js";
import { gitOutput } from "./renderPlan.js";
import { gitRun, runGit } from "./repoWorkspaceCore.js";
import { ensureDetachedAtCommit } from "./repoWorktrees.js";

/** A pinned scope whose worktree HEAD is not the pin, after any requested rehydration. */
export interface DriftedScope {
	repoId: string;
	path: string;
	head: string;
	pin: string;
	ref: string;
}

export function validateExistingProverRepo(
	repoId: string,
	scope: ScopeRef,
	targetPath: string,
	commit: string,
): string[] {
	const warnings: string[] = [];
	if (scope.ref) {
		const mergeBase = runGit(targetPath, ["merge-base", "--is-ancestor", commit, "HEAD"]);
		if (mergeBase.status === 1) {
			throw new Error(
				`scoped repo ${repoId} at ${formatPath(targetPath)} cannot prove assertion pinned at ${commit}: pinned commit is not reachable from HEAD`,
			);
		}
		if (mergeBase.status !== 0) {
			const detail = mergeBase.stderr.trim() || mergeBase.stdout.trim() || "unknown git error";
			throw new Error(
				`failed to check pinned commit reachability for scoped repo ${repoId} at ${formatPath(targetPath)}: ${detail}`,
			);
		}

		const head = gitRun(
			targetPath,
			["rev-parse", "HEAD"],
			`failed to inspect HEAD for scoped repo ${repoId}`,
		);
		if (head !== commit) {
			warnings.push(
				`scoped repo ${repoId} at ${formatPath(targetPath)} is ahead of pinned commit ${commit} (${scope.ref}); continuing`,
			);
		}
	}

	const status = gitOutput(targetPath, ["status", "--porcelain"]);
	if (status === undefined) {
		warnings.push(
			`could not read dirty status for scoped repo ${repoId} at ${formatPath(targetPath)}; continuing`,
		);
	} else if (status.trim() !== "") {
		warnings.push(`scoped repo ${repoId} at ${formatPath(targetPath)} is dirty; continuing`);
	}

	return warnings;
}

/**
 * Move a pinned scope's worktree back to its pin. Refuses on tracked local
 * modifications unless the pilot passed --force, because `git checkout --detach`
 * only balks at *conflicting* changes and would otherwise carry uncommitted work
 * onto the pin. Untracked files are not checked here: they cannot ride onto the
 * pin, `checkout --force` could not discard them anyway, and the existing
 * dirty-input refusal already stops them reaching a recording.
 */
export function rehydrateScopedRepoAtPin(
	repoId: string,
	scope: ScopeRef,
	targetPath: string,
	commit: string,
	force: boolean,
	warnings: string[],
): void {
	const head = gitRun(
		targetPath,
		["rev-parse", "HEAD"],
		`failed to inspect HEAD for scoped repo ${repoId}`,
	);
	if (head === commit) return;

	if (!force) {
		const status = gitOutput(targetPath, ["status", "--porcelain", "--untracked-files=no"]);
		if (status === undefined) {
			throw new Error(
				`refusing to rehydrate scoped repo ${repoId} at ${formatPath(targetPath)}: could not read dirty status`,
			);
		}
		if (status.trim() !== "") {
			throw new Error(
				`refusing to rehydrate scoped repo ${repoId} at ${formatPath(targetPath)}: checkout has uncommitted work; rerun with --force to discard it`,
			);
		}
	}

	ensureDetachedAtCommit(targetPath, commit, repoId, force);
	warnings.push(
		`rehydrated scoped repo ${repoId} at ${formatPath(targetPath)} from ${head} to pinned commit ${commit} (${scope.ref})`,
	);
}

export function driftedScope(
	repoId: string,
	scope: ScopeRef,
	targetPath: string,
	commit: string,
): DriftedScope | undefined {
	if (!scope.ref) return undefined;
	const head = gitRun(
		targetPath,
		["rev-parse", "HEAD"],
		`failed to inspect HEAD for scoped repo ${repoId}`,
	);
	if (head === commit) return undefined;
	return { repoId, path: targetPath, head, pin: commit, ref: scope.ref };
}
