import { readNosediveRc } from "./coreParsing.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { bridgeTrunk } from "./helmBranch.js";
import {
	commitLog,
	logged,
	said,
	syncTarget,
	type HelmBranchCommit,
	type HelmSyncResult,
} from "./helmSync.js";
import { HelmRequestError } from "./helmWrites.js";
import { gitRun } from "./repoWorkspaceCore.js";

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
			commits: commitLog(cwd, `HEAD..${ref}`, 50),
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
