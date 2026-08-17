import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { formatPath } from "./coreParsing.js";
import { gitOutput, runGit } from "./gitProcess.js";
import type { KbDoc } from "./kbDocs.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	gitRun,
	maybeResolveRepoDoc,
} from "./repoWorkspaceCore.js";
import {
	expectedWorktreePath,
	isDirEmpty,
	pruneStaleWorktrees,
	resolveRefCommit,
	ensureReusableExistingTarget,
} from "./repoWorktrees.js";

export interface HydratedScope {
	repoDoc: KbDoc;
	sourcePath: string;
	targetPath: string;
	commit: string;
	created: boolean;
}

/**
 * Creates a scoped worktree only when its target is absent. Existing worktrees
 * are validated but never checked out or otherwise changed: a caller can safely
 * compare their HEAD with `commit` and report that it proved a different tree.
 */
export function hydrateScopeAtPin(
	scope: { repoId: string; ref?: string },
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string,
	fallbackToRepoTrunk = false,
): HydratedScope {
	const repoDoc = maybeResolveRepoDoc(kbDocs, scope.repoId);
	if (!repoDoc) throw new Error(`scoped repo names a repo with no kb repo doc: ${scope.repoId}`);
	const ref = scope.ref ?? (fallbackToRepoTrunk ? repoDoc.repoBaseBranch : undefined);
	if (!ref) throw new Error(`scoped repo ${scope.repoId} has no pinned ref to hydrate at`);

	const sourcePath = ensureManagedRepoCache(repoDoc, bridgeDir);
	const targetPath = expectedWorktreePath(repoDoc, bridgeDir);
	ensureSafeTargetPath(scope.repoId, targetPath, workspaceDir);
	const commit = resolveRefCommit(sourcePath, scope.repoId, ref);
	const targetExists = existsSync(targetPath);
	if (targetExists && !statSync(targetPath).isDirectory()) {
		throw new Error(
			`unsafe target path for repo ${scope.repoId}: target exists but is not a directory: ${formatPath(targetPath)}`,
		);
	}

	if (targetExists && !isDirEmpty(targetPath)) {
		ensureReusableExistingTarget(scope.repoId, targetPath, sourcePath);
		return { repoDoc, sourcePath, targetPath, commit, created: false };
	}

	mkdirSync(dirname(targetPath), { recursive: true });
	pruneStaleWorktrees(sourcePath, scope.repoId);
	gitRun(
		sourcePath,
		["worktree", "add", "--detach", targetPath, commit],
		`failed to create worktree for repo ${scope.repoId} at ${formatPath(targetPath)}`,
	);
	return { repoDoc, sourcePath, targetPath, commit, created: true };
}

export interface StalePin {
	/** Commits on trunk that the pin does not have. */
	behind: number;
	trunk: string;
	trunkCommit: string;
}

/**
 * How far a pin has fallen behind trunk since it was chosen, or `undefined`
 * when it has not.
 *
 * Reads only refs the caller's hydration has already fetched. A staleness check
 * that went to the network itself would make every jump pay a round trip and
 * would turn an offline machine into a blocked one, so a cache that has never
 * seen trunk reports nothing rather than guessing.
 *
 * Only a strict ancestor counts. A pin ahead of trunk, or one that has diverged
 * from it, is not a dive that waited too long -- it is a dive somebody pinned
 * deliberately, and saying "behind" about it would be false.
 */
export function pinBehindTrunk(
	sourcePath: string,
	commit: string,
	trunk: string,
): StalePin | undefined {
	const trunkCommit = gitOutput(sourcePath, [
		"rev-parse",
		"--verify",
		`refs/remotes/origin/${trunk}^{commit}`,
	]);
	if (!trunkCommit || trunkCommit === commit) return undefined;
	if (runGit(sourcePath, ["merge-base", "--is-ancestor", commit, trunkCommit]).status !== 0) {
		return undefined;
	}
	const behind = Number(
		gitOutput(sourcePath, ["rev-list", "--count", `${commit}..${trunkCommit}`]),
	);
	if (!Number.isFinite(behind) || behind <= 0) return undefined;
	return { behind, trunk, trunkCommit };
}
