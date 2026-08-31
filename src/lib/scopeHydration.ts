import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { formatPath } from "./coreParsing.js";
import { HYDRATE_UNPUBLISHED_COMMIT_ERROR_ID } from "./constants.js";
import { gitOutput, runGit } from "./gitProcess.js";
import type { KbDoc } from "./kbDocs.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	gitRun,
	maybeResolveRepoDoc,
} from "./repoWorkspaceCore.js";
import {
	dehydrateHasUnpublishedCommits,
	ensureDetachedAtCommit,
	expectedWorktreePath,
	isDirEmpty,
	pruneStaleWorktrees,
	resolveRefCommit,
	ensureReusableExistingTarget,
	trunkAbsorbsHead,
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
 * Moves an already-existing scoped worktree onto its pin, reporting the commit
 * it came off, or `undefined` when nothing moved.
 *
 * Never forces: `ensureDetachedAtCommit` only passes `--force` when told to, so
 * git itself refuses when uncommitted changes would be clobbered. Committed
 * work is not git's problem to catch, which is what `unmovableScopes` below is
 * for -- call it over every scope before calling this over any of them.
 */
export function moveScopeToPin(hydrated: HydratedScope): string | undefined {
	if (hydrated.created) return undefined;
	const head = gitOutput(hydrated.targetPath, ["rev-parse", "HEAD"]);
	if (!ensureDetachedAtCommit(hydrated.targetPath, hydrated.commit, hydrated.repoDoc.id)) {
		return undefined;
	}
	return head ?? undefined;
}

/**
 * The scopes whose worktrees sit on commits no ref reaches, and so must not be
 * moved to their pins.
 *
 * This is `hydrate-repo.workspace`'s rule, deliberately shared rather than
 * re-derived: move a published worktree, refuse one carrying commits that exist
 * nowhere else. A pin the worktree is already on is not a move and is never
 * refused, and a freshly created worktree has nothing to lose.
 */
function unmovableScopes(hydrated: HydratedScope[]): UnmovableScope[] {
	const unmovable: UnmovableScope[] = [];
	for (const scope of hydrated) {
		if (scope.created) continue;
		const head = gitOutput(scope.targetPath, ["rev-parse", "HEAD"]);
		if (!head || head === scope.commit) continue;
		if (!dehydrateHasUnpublishedCommits(scope.targetPath)) continue;
		const trunk = scope.repoDoc.repoBaseBranch;
		if (trunk && trunkAbsorbsHead(scope.targetPath, trunk)) continue;
		unmovable.push({
			repoName: scope.repoDoc.name || scope.repoDoc.id,
			targetPath: scope.targetPath,
			head,
			commit: scope.commit,
		});
	}
	return unmovable;
}

interface UnmovableScope {
	repoName: string;
	targetPath: string;
	head: string;
	commit: string;
}

/**
 * Refuses the whole set, or returns and lets every scope be moved.
 *
 * All-or-nothing because a refusal that has already relocated three of five
 * worktrees is not a refusal -- callers hand the entire hydrated set here
 * before touching any of it.
 *
 * The refusal is prose rather than the bare error id. `src/cli.ts` only renders
 * the `more info: ... render <id>` line when the whole thrown message is
 * uuid-shaped, and a refusal that does not say which repo it is about is
 * unactionable -- so the message carries the repo context and names the memo
 * itself. The memo's three recourses are not restated: a message that repeats
 * them is one nobody reads twice.
 *
 * The repin hint is separate from those recourses. `land` pushes to the origin
 * URL rather than the remote name, so a just-landed worktree reads as
 * unpublished until something fetches -- and the fetch inside a repin is what
 * clears it. Without saying so, the correct refusal reads as a bug.
 */
export function refuseUnmovableScopes(hydrated: HydratedScope[], repinCommand: string): void {
	const unmovable = unmovableScopes(hydrated);
	if (unmovable.length === 0) return;
	const lines = unmovable
		.map(
			(scope) =>
				`- repo=${scope.repoName} path=${formatPath(scope.targetPath)} ` +
				`head=${scope.head} pin=${scope.commit}`,
		)
		.join("\n");
	throw new Error(
		`refusing to move ${unmovable.length} hydrated worktree${unmovable.length === 1 ? "" : "s"} ` +
			`off commits no local or remote ref contains; no scope was moved:\n${lines}\n` +
			`nosedive render ${HYDRATE_UNPUBLISHED_COMMIT_ERROR_ID} for the recourses. ` +
			`A worktree \`land\` has just pushed reads as unpublished until a fetch records it, ` +
			`so in a stacked chain run \`${repinCommand}\` before jumping.`,
	);
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
