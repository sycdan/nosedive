import { readNosediveRc } from "./coreParsing.js";
import { gitOutput, runGit, type GitCommandResult } from "./gitProcess.js";
import { bridgeTrunk } from "./helmBranch.js";
import { appendHelmLog } from "./helmLog.js";
import { HelmRequestError } from "./helmWrites.js";
import { readActiveDiveId } from "./kbDocs.js";
import { gitRun } from "./repoWorkspaceCore.js";

export interface HelmSyncResult {
	output: string;
}

function said(result: GitCommandResult): string {
	return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

/**
 * Runs a pull or push and logs it, whatever the outcome, filed under the dive
 * active before it. A refusal or failure is logged, then rethrown unchanged.
 */
function logged(cwd: string, action: string, run: () => HelmSyncResult): HelmSyncResult {
	const dive = readActiveDiveId(readNosediveRc(cwd).workspaceDir);
	try {
		const result = run();
		appendHelmLog(cwd, dive, [action], `${result.output}\n[exit 0]`);
		return result;
	} catch (err) {
		appendHelmLog(cwd, dive, [action], `${(err as Error).message}\n[exit 1]`);
		throw err;
	}
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
	return logged(cwd, "pull", () => pull(cwd));
}

function pull(cwd: string): HelmSyncResult {
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
 * On trunk, fast-forwards `origin/<trunk>` to the checkout's head, never
 * forced. Off trunk, force-updates only `origin/<branch>`, with a lease:
 * a branch never writes trunk.
 */
export function helmPush(cwd: string): HelmSyncResult {
	return logged(cwd, "push", () => push(cwd));
}

function push(cwd: string): HelmSyncResult {
	const { trunk, branch } = syncTarget(cwd, "push");
	if (branch !== trunk) {
		const branchPush = runGit(cwd, [
			"push",
			"--force-with-lease",
			"origin",
			`HEAD:refs/heads/${branch}`,
		]);
		if (branchPush.status !== 0)
			throw new HelmRequestError(409, `push to origin/${branch} rejected:\n${said(branchPush)}`);
		return { output: said(branchPush) };
	}
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
	return { output: output.filter(Boolean).join("\n") };
}
