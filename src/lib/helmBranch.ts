import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { formatPath, type NosediveRc } from "./coreParsing.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { loadKbDocs } from "./kbDocs.js";
import { gitRun } from "./repoWorkspaceCore.js";
import { worktreeHasExpectedSource } from "./repoWorktrees.js";

/** The bridge's trunk: its own repo doc's base branch, else main. */
export function bridgeTrunk(rc: NosediveRc): string {
	const doc =
		rc.kbDir && rc.bridge
			? loadKbDocs(rc.kbDir, rc.bridgeDir).find((d) => d.id === rc.bridge)
			: undefined;
	return doc?.repoBaseBranch ?? "main";
}

/** Whether `dir` is the repo's own checkout rather than a linked worktree of it. */
export function isPrimaryWorktree(dir: string): boolean {
	return gitOutput(dir, ["rev-parse", "--git-dir"]) === ".git";
}

/**
 * The sibling worktree `<bridge-dir>-<branch>` that `helm <branch>` serves,
 * made when missing: a local branch is checked out as it is; a new one starts
 * at `origin/<trunk>` and is published, so dives there have an upstream to
 * push their records to. A path there that is not a worktree of this bridge
 * is refused rather than reused. The branch the bridge's own checkout is on
 * is served from there.
 */
export function branchWorktree(
	bridgeDir: string,
	branch: string,
	trunk: string,
	io: { log(message: string): void },
): string {
	if (runGit(bridgeDir, ["check-ref-format", "--branch", branch]).status !== 0)
		throw new Error(`not a branch name: ${branch}`);
	// Named after the bridge's own checkout, wherever helm is run from.
	const common = gitOutput(bridgeDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const primary = common ? resolve(dirname(common)) : bridgeDir;
	if (gitOutput(primary, ["rev-parse", "--abbrev-ref", "HEAD"]) === branch) return primary;
	bridgeDir = primary;
	const path = join(dirname(bridgeDir), `${basename(bridgeDir)}-${branch.replaceAll("/", "-")}`);
	if (existsSync(path)) {
		if (!worktreeHasExpectedSource(path, bridgeDir))
			throw new Error(`${formatPath(path)} exists and is not a worktree of this bridge`);
		return path;
	}
	const local = runGit(bridgeDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (local.status === 0) {
		gitRun(bridgeDir, ["worktree", "add", path, branch], `failed to check out ${branch}`);
	} else {
		gitRun(bridgeDir, ["fetch", "--quiet", "origin", trunk], `failed to fetch origin ${trunk}`);
		gitRun(
			bridgeDir,
			["worktree", "add", "-b", branch, path, `origin/${trunk}`],
			`failed to make ${branch} off origin/${trunk}`,
		);
		gitRun(path, ["push", "--quiet", "-u", "origin", branch], `failed to publish ${branch}`);
	}
	io.log(`helm: serving ${formatPath(path)} on ${branch}`);
	return path;
}

export interface HelmBranchStatus {
	name: string;
	trunk: string;
	/** Commits the branch has that `origin/<trunk>` lacks, and the reverse; unknown without that ref. */
	ahead?: number;
	behind?: number;
}

/** The branch helm's bridge has checked out, and where it stands against `origin/<trunk>`. */
export function helmBranchStatus(dir: string, trunk: string): HelmBranchStatus {
	const name = gitOutput(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "?";
	const counts = gitOutput(dir, ["rev-list", "--left-right", "--count", `HEAD...origin/${trunk}`]);
	const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [];
	return { name, trunk, ahead, behind };
}
