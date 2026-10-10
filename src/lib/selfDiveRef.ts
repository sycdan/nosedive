import { existsSync } from "node:fs";
import { join } from "node:path";

import { formatPath } from "./coreParsing.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { fetchLiveBridge } from "./landBridgeScope.js";
import { originUrl } from "./landPush.js";
import { gitRun } from "./repoWorkspaceCore.js";

/**
 * A dive's work in its checkout of the bridge (`__self`) is commits in the
 * bridge's own repo, so pack keeps them as commits, on a ref of the dive's on
 * the bridge's remote, rather than as patches: jump rebases them onto the
 * bridge as it then stands, and git's three-way merge reads past the
 * bookkeeping jump and pack rewrite on the same lines. Work not yet committed
 * rides along as one last commit, undone again on the way back.
 */
export const selfDiveRef = (diveId: string): string => `refs/nosedive/dives/${diveId}`;

const UNCOMMITTED = "nosedive: uncommitted when the dive was packed";

/** Whether a checkout is partway through a rebase, which only its pilot can finish. */
export function midRebase(checkout: string): boolean {
	const gitDir = gitOutput(checkout, ["rev-parse", "--absolute-git-dir"]);
	return !!gitDir && ["rebase-merge", "rebase-apply"].some((dir) => existsSync(join(gitDir, dir)));
}

export function refuseMidRebase(checkout: string, verb: string): void {
	if (midRebase(checkout))
		throw new Error(
			`refusing to ${verb}: ${formatPath(checkout)} is mid-rebase; ` +
				"resolve it there and run `git rebase --continue`, or `git rebase --abort` to drop the dive's work from it",
		);
}

/** The commits `__self` holds that the live bridge does not, under any hash, oldest first. */
function ownCommits(checkout: string, live: string): string[] {
	const listed = gitOutput(checkout, [
		"rev-list",
		"--reverse",
		"--no-merges",
		"--right-only",
		"--cherry-pick",
		`${live}...HEAD`,
	]);
	return listed ? listed.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * Pushes `__self`'s work to the dive's ref -- or deletes the ref when there is
 * none -- and returns how many commits it holds. Before pack commits anything,
 * so a pack that cannot store the work records nothing.
 */
export function packSelf(bridgeDir: string, checkout: string, diveId: string): number {
	refuseMidRebase(checkout, "pack");
	if (gitOutput(checkout, ["status", "--porcelain"])) {
		gitRun(checkout, ["add", "-A"], "failed to stage __self's uncommitted work");
		gitRun(
			checkout,
			["commit", "--quiet", "-m", UNCOMMITTED],
			"failed to commit __self's uncommitted work",
		);
	}
	const commits = ownCommits(checkout, fetchLiveBridge(bridgeDir, checkout));
	const url = originUrl(checkout);
	if (commits.length > 0)
		gitRun(
			checkout,
			["push", "--quiet", "--force", url, `HEAD:${selfDiveRef(diveId)}`],
			`failed to push __self's work to ${selfDiveRef(diveId)}`,
		);
	else runGit(checkout, ["push", "--quiet", url, `:${selfDiveRef(diveId)}`]);
	return commits.length;
}

/** Puts `__self` on the live bridge's HEAD, as pack and land leave it and jump starts it. */
export function settleSelf(bridgeDir: string, checkout: string): string {
	const head = fetchLiveBridge(bridgeDir, checkout);
	gitRun(
		checkout,
		["checkout", "--quiet", "--detach", head],
		`failed to put ${formatPath(checkout)} on the live bridge`,
	);
	return head;
}

/**
 * Starts `__self` on the live bridge, as jump has just left it, and rebases the
 * dive's packed work onto it. A conflict is left mid-rebase for the pilot to
 * resolve, and the ref keeps the work until land; returns false then.
 */
export function jumpSelf(
	bridgeDir: string,
	checkout: string,
	diveId: string,
	io: { err(message: string): void },
): boolean {
	const head = settleSelf(bridgeDir, checkout);
	if (runGit(checkout, ["fetch", "--quiet", originUrl(checkout), selfDiveRef(diveId)]).status !== 0)
		return true;
	const tip = gitRun(checkout, ["rev-parse", "FETCH_HEAD"], "failed to read the dive's ref");
	const rebased = runGit(checkout, ["rebase", "--quiet", head, tip]);
	if (rebased.status !== 0) {
		const conflicts = (gitOutput(checkout, ["diff", "--name-only", "--diff-filter=U"]) ?? "")
			.split(/\r?\n/)
			.filter(Boolean);
		io.err(
			`jump: the dive's work in ${formatPath(checkout)} does not rebase onto the live bridge; ` +
				`these files conflict: ${conflicts.join(", ") || rebased.stderr.trim()}\n` +
				`Resolve them there and run \`git rebase --continue\`; the work is kept on ${selfDiveRef(diveId)} until land.`,
		);
		return false;
	}
	if (gitOutput(checkout, ["log", "-1", "--format=%s"]) === UNCOMMITTED)
		gitRun(checkout, ["reset", "--quiet", "HEAD~1"], "failed to restore __self's uncommitted work");
	return true;
}

/** Drops the dive's ref once land has published its work or bail has given it up. */
export function dropSelfRef(checkout: string, diveId: string): void {
	runGit(checkout, ["push", "--quiet", originUrl(checkout), `:${selfDiveRef(diveId)}`]);
}
