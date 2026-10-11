import { dirname, resolve } from "node:path";
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
	onTrunk: boolean;
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
 * has over the local trunk. Off trunk the list is read-only.
 */
export function helmBranches(cwd: string): HelmBranches {
	const trunk = bridgeTrunk(readNosediveRc(cwd));
	const isTrunk = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) === trunk;
	const base = `refs/heads/${trunk}`;
	const fetched = runGit(cwd, ["fetch", "--prune", "origin"]);
	if (fetched.status !== 0)
		throw new HelmRequestError(409, `failed to fetch origin:\n${said(fetched)}`);
	const branches = remoteBranchNames(cwd, trunk).map((name) => {
		const ref = `refs/remotes/origin/${name}`;
		const counts = gitOutput(cwd, ["rev-list", "--left-right", "--count", `${ref}...${base}`]);
		const [ahead = 0, behind = 0] = counts ? counts.split(/\s+/).map(Number) : [];
		const ancestor = runGit(cwd, ["merge-base", "--is-ancestor", base, ref]).status === 0;
		return {
			name,
			head: gitOutput(cwd, ["rev-parse", "--short", ref]) ?? "",
			ahead,
			behind,
			mergeable: ancestor && ahead > 0,
			commits: commitLog(cwd, `${base}..${ref}`, 50),
		};
	});
	return { trunk, onTrunk: isTrunk, branches };
}

/**
 * Fast-forwards the local trunk to `origin/<branch>`, logged. Refused while a
 * dive is active, off trunk, with uncommitted changes, or once trunk has moved
 * on. Never pushes.
 */
export function helmMerge(cwd: string, branch: string): HelmSyncResult {
	return logged(cwd, `merge ${branch}`, () => merge(cwd, branch));
}

/** Deletes a fetched origin branch on trunk, then removes its clean helm worktree. */
export function helmDeleteBranch(cwd: string, branch: string): HelmSyncResult {
	return logged(cwd, `delete branch ${branch}`, () => {
		const trunk = onTrunk(cwd, "delete branches");
		if (branch === trunk) throw new HelmRequestError(400, `cannot delete trunk ${trunk}`);
		if (!remoteBranchNames(cwd, trunk).includes(branch))
			throw new HelmRequestError(400, `no fetched origin branch named ${JSON.stringify(branch)}`);
		const deleted = runGit(cwd, ["push", "origin", "--delete", branch]);
		if (deleted.status !== 0)
			throw new HelmRequestError(409, `delete of origin/${branch} failed:\n${said(deleted)}`);
		const output = [said(deleted)];
		const fetched = runGit(cwd, ["fetch", "--prune", "origin"]);
		if (fetched.status !== 0) output.push(`branch deleted; fetch failed:\n${said(fetched)}`);
		const common = gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const primary = common ? dirname(common) : cwd;
		const expected = resolve(`${primary}-${branch.replaceAll("/", "-")}`);
		const worktrees = gitRun(
			cwd,
			["worktree", "list", "--porcelain", "-z"],
			"failed to list worktrees",
		);
		const matches = worktrees.split("\0\0").some((entry) => {
			const fields = entry.split("\0");
			const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
			return path && resolve(path) === expected && fields.includes(`branch refs/heads/${branch}`);
		});
		if (matches) {
			const status = runGit(expected, ["status", "--porcelain", "--untracked-files=all"]);
			if (status.status !== 0 || status.stdout.trim()) {
				output.push(
					`kept ${expected} and local ${branch}: worktree is dirty or its status could not be read`,
				);
			} else {
				const removed = runGit(cwd, ["worktree", "remove", expected]);
				if (removed.status !== 0) output.push(`kept ${expected}: ${said(removed)}`);
				else {
					output.push(`removed clean worktree ${expected}`);
					const local = runGit(cwd, ["branch", "-D", "--", branch]);
					output.push(local.status === 0 ? said(local) : `local branch kept: ${said(local)}`);
				}
			}
			output.push(`stop any helm running for ${branch}`);
		}
		return { output: output.filter(Boolean).join("\n") };
	});
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
