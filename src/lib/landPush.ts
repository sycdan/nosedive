import { formatPath } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { leaseRefusal, movedBranchRefusal, type LandLease } from "./landRefusals.js";
import { gitRun } from "./repoWorkspaceCore.js";

export function originUrl(worktreePath: string): string {
	return gitRun(
		worktreePath,
		["config", "--get", "remote.origin.url"],
		`failed to resolve origin URL for ${formatPath(worktreePath)}`,
	);
}

/**
 * Push one scoped repo's current HEAD to its recorded work branch on its own
 * cloud remote (read-only scopes never reach here).
 *
 * Deliberately by resolved URL rather than by remote name: hydration leaves
 * every worktree with a `remote.origin.pushurl` sentinel so an agent working in
 * it cannot push, and a `pushurl` override applies only to the *named* remote.
 * Landing this way means the isolation is never lifted, not even briefly.
 *
 * `lease` carries the `--hard` case. Its expected value is spelled out rather
 * than left to git: a URL push maintains no `refs/remotes/origin/<branch>`, and
 * a valueless `--force-with-lease` resolved against a ref that does not exist
 * is a silent unconditional force. Naming the dive's own pin is also what gives
 * the flag its meaning -- replace the branch only while it still stands where
 * this dive started -- and refuses an absent branch for free, since git rejects
 * a non-empty expected value against a ref that is not there.
 */
export function landRepoScope(
	worktreePath: string,
	branch: string,
	scope: LandLease,
	hard: boolean,
): string {
	const url = originUrl(worktreePath);
	const force = hard ? [`--force-with-lease=refs/heads/${branch}:${scope.pin}`] : [];
	try {
		gitRun(
			worktreePath,
			["push", url, ...force, `HEAD:refs/heads/${branch}`],
			hard
				? leaseRefusal(branch, scope)
				: `failed to push ${formatPath(worktreePath)} to ${branch}`,
		);
	} catch (error) {
		if (!hard) {
			const published = remoteBranchHead(worktreePath, branch, scope.repoId);
			if (published && published !== scope.pin && !headContains(worktreePath, published)) {
				throw new Error(movedBranchRefusal(branch, published, scope));
			}
		}
		throw error;
	}
	return branch;
}

/** The published head of `branch` on the scope's own remote, or undefined when it has none. */
export function remoteBranchHead(
	worktreePath: string,
	branch: string,
	repoId: string,
): string | undefined {
	const line = gitRun(
		worktreePath,
		["ls-remote", originUrl(worktreePath), `refs/heads/${branch}`],
		`land refused because the published head of ${branch} on scope ${repoId}'s remote could not be read`,
	);
	return line ? line.split(/\s+/)[0] : undefined;
}

/**
 * Whether this worktree's HEAD already contains `sha`. A commit the worktree
 * does not have cannot be an ancestor of its HEAD, so a `merge-base` that fails
 * on a missing object answers the same question correctly.
 */
export function headContains(worktreePath: string, sha: string): boolean {
	return gitOutput(worktreePath, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== undefined;
}
