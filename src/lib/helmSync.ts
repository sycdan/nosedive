import { readNosediveRc } from "./coreParsing.js";
import { gitOutput, runGit, type GitCommandResult } from "./gitProcess.js";
import { bridgeTrunk } from "./helmBranch.js";
import { HelmRequestError } from "./helmWrites.js";
import { readActiveDiveId } from "./kbDocs.js";
import { gitRun } from "./repoWorkspaceCore.js";

export interface HelmSyncResult {
	output: string;
}

function said(result: GitCommandResult): string {
	return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

/** The trunk and branch of the checkout helm serves, refused while a dive is active. */
function syncTarget(cwd: string, action: string): { trunk: string; branch: string } {
	const rc = readNosediveRc(cwd);
	if (readActiveDiveId(rc.workspaceDir))
		throw new HelmRequestError(409, `cannot ${action} while a dive is active`);
	const branch = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch || branch === "HEAD")
		throw new HelmRequestError(400, `cannot ${action} without a branch checked out`);
	return { trunk: bridgeTrunk(rc), branch };
}

/** Fetches `origin/<trunk>`, returning what git said. */
function fetchTrunk(cwd: string, trunk: string): string {
	const fetched = runGit(cwd, ["fetch", "origin", trunk]);
	if (fetched.status !== 0)
		throw new HelmRequestError(409, `failed to fetch origin ${trunk}:\n${said(fetched)}`);
	return said(fetched);
}

/**
 * Rebases the checkout onto `origin/<trunk>`. A clean tree is required, and a
 * conflicting rebase is aborted, leaving the checkout as it was.
 */
export function helmPull(cwd: string): HelmSyncResult {
	const { trunk } = syncTarget(cwd, "pull");
	if (gitRun(cwd, ["status", "--porcelain", "--untracked-files=no"], "failed to read status"))
		throw new HelmRequestError(409, "cannot pull with uncommitted changes; commit or discard them");
	const output = [fetchTrunk(cwd, trunk)];
	const rebased = runGit(cwd, ["rebase", `origin/${trunk}`]);
	if (rebased.status !== 0) {
		// Read before aborting: the abort clears the unmerged entries.
		const conflicts = gitOutput(cwd, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
		gitRun(cwd, ["rebase", "--abort"], "failed to abort the rebase");
		throw new HelmRequestError(
			409,
			conflicts
				? `pull conflicts with origin/${trunk} in:\n${conflicts}\nnothing was changed`
				: `rebase onto origin/${trunk} failed and was aborted:\n${said(rebased)}`,
		);
	}
	output.push(said(rebased));
	return { output: output.filter(Boolean).join("\n") };
}

/**
 * Fast-forwards `origin/<trunk>` to the checkout's head -- never forced --
 * and, off trunk, force-updates the branch's own upstream with a lease.
 */
export function helmPush(cwd: string): HelmSyncResult {
	const { trunk, branch } = syncTarget(cwd, "push");
	const output = [fetchTrunk(cwd, trunk)];
	if (runGit(cwd, ["merge-base", "--is-ancestor", `origin/${trunk}`, "HEAD"]).status !== 0)
		throw new HelmRequestError(
			409,
			`origin/${trunk} has commits this checkout lacks; pull first, then push`,
		);
	const trunkPush = runGit(cwd, ["push", "origin", `HEAD:refs/heads/${trunk}`]);
	if (trunkPush.status !== 0)
		throw new HelmRequestError(409, `push to origin/${trunk} rejected:\n${said(trunkPush)}`);
	output.push(said(trunkPush));
	if (branch !== trunk) {
		const branchPush = runGit(cwd, [
			"push",
			"--force-with-lease",
			"origin",
			`HEAD:refs/heads/${branch}`,
		]);
		if (branchPush.status !== 0)
			throw new HelmRequestError(
				409,
				`origin/${trunk} was updated, but the push to origin/${branch} was rejected:\n${said(branchPush)}`,
			);
		output.push(said(branchPush));
	}
	return { output: output.filter(Boolean).join("\n") };
}
