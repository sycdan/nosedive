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

/** A commit on a remote branch that the local trunk lacks. */
export interface HelmBranchCommit {
	hash: string;
	subject: string;
	author: string;
	at: number;
}

/** One of origin's branches, against the local trunk's HEAD. */
export interface HelmRemoteBranch {
	name: string;
	head: string;
	ahead: number;
	behind: number;
	mergeable: boolean;
	commits: HelmBranchCommit[];
}

export interface HelmBranches {
	trunk: string;
	branches: HelmRemoteBranch[];
}

/** The trunk, refused unless the checkout is on it. */
function onTrunk(cwd: string, action: string): string {
	const trunk = bridgeTrunk(readNosediveRc(cwd));
	if (gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) !== trunk)
		throw new HelmRequestError(409, `cannot ${action} off ${trunk}; use the helm on ${trunk}`);
	return trunk;
}

/** Names of origin's fetched branches besides trunk, newest tip first. */
function remoteBranchNames(cwd: string, trunk: string): string[] {
	const refs = gitOutput(cwd, [
		"for-each-ref",
		"--sort=-committerdate",
		"--format=%(refname:lstrip=3)",
		"refs/remotes/origin/",
	]);
	return (refs ?? "").split("\n").filter((name) => name && name !== trunk && name !== "HEAD");
}

function branchCommits(cwd: string, name: string): HelmBranchCommit[] {
	const log = gitOutput(cwd, [
		"log",
		"-50",
		"--format=%h%x1f%s%x1f%an%x1f%ct",
		`HEAD..refs/remotes/origin/${name}`,
	]);
	if (!log) return [];
	return log.split("\n").map((line) => {
		const [hash = "", subject = "", author = "", ct = "0"] = line.split("\x1f");
		return { hash, subject, author, at: Number(ct) * 1000 };
	});
}

/**
 * Fetches origin, pruned, and lists its branches besides trunk with what each
 * has over the local trunk. Only on trunk.
 */
export function helmBranches(cwd: string): HelmBranches {
	const trunk = onTrunk(cwd, "list branches");
	const fetched = runGit(cwd, ["fetch", "--prune", "origin"]);
	if (fetched.status !== 0)
		throw new HelmRequestError(409, `failed to fetch origin:\n${said(fetched)}`);
	const branches = remoteBranchNames(cwd, trunk).map((name) => {
		const ref = `refs/remotes/origin/${name}`;
		const counts = gitOutput(cwd, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
		const [ahead = 0, behind = 0] = counts ? counts.split(/\s+/).map(Number) : [];
		const ancestor = runGit(cwd, ["merge-base", "--is-ancestor", "HEAD", ref]).status === 0;
		return {
			name,
			head: gitOutput(cwd, ["rev-parse", "--short", ref]) ?? "",
			ahead,
			behind,
			mergeable: ancestor && ahead > 0,
			commits: branchCommits(cwd, name),
		};
	});
	return { trunk, branches };
}

/**
 * Fast-forwards the local trunk to `origin/<branch>`, logged. Refused while a
 * dive is active, off trunk, with uncommitted changes, or once trunk has moved
 * on. Never pushes.
 */
export function helmMerge(cwd: string, branch: string): HelmSyncResult {
	return logged(cwd, `merge ${branch}`, () => merge(cwd, branch));
}

function merge(cwd: string, branch: string): HelmSyncResult {
	syncTarget(cwd, "merge");
	const trunk = onTrunk(cwd, "merge");
	if (gitRun(cwd, ["status", "--porcelain", "--untracked-files=no"], "failed to read status"))
		throw new HelmRequestError(
			409,
			"cannot merge with uncommitted changes; commit or discard them",
		);
	// Only a name from the fetched list reaches git.
	if (!remoteBranchNames(cwd, trunk).includes(branch))
		throw new HelmRequestError(400, `no fetched origin branch named ${JSON.stringify(branch)}`);
	const ref = `refs/remotes/origin/${branch}`;
	if (runGit(cwd, ["merge-base", "--is-ancestor", "HEAD", ref]).status !== 0)
		throw new HelmRequestError(
			409,
			`${trunk} has commits origin/${branch} lacks; Pull in ${branch}'s helm first, then merge`,
		);
	const merged = runGit(cwd, ["merge", "--ff-only", `origin/${branch}`]);
	if (merged.status !== 0)
		throw new HelmRequestError(409, `merge of origin/${branch} failed:\n${said(merged)}`);
	return {
		output: [
			said(merged),
			`local ${trunk} moved to origin/${branch}; nothing was pushed, Push publishes it`,
		]
			.filter(Boolean)
			.join("\n"),
	};
}
