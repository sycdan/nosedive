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

/** Git's stdout and stderr, trimmed and joined. */
export function said(result: GitCommandResult): string {
	return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

/**
 * Runs a sync action and logs it, whatever the outcome, filed under the dive
 * active before it. A refusal or failure is logged, then rethrown unchanged.
 */
export function logged(cwd: string, action: string, run: () => HelmSyncResult): HelmSyncResult {
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
export function syncTarget(cwd: string, action: string): { trunk: string; branch: string } {
	const rc = readNosediveRc(cwd);
	if (readActiveDiveId(rc.workspaceDir))
		throw new HelmRequestError(409, `cannot ${action} while a dive is active`);
	const branch = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (!branch || branch === "HEAD")
		throw new HelmRequestError(400, `cannot ${action} without a branch checked out`);
	return { trunk: bridgeTrunk(rc), branch };
}

/** Fetches `origin/<trunk>`, returning what git said. */
export function fetchTrunk(cwd: string, trunk: string): string {
	const fetched = runGit(cwd, ["fetch", "origin", trunk]);
	if (fetched.status !== 0)
		throw new HelmRequestError(409, `failed to fetch origin ${trunk}:\n${said(fetched)}`);
	return said(fetched);
}

/**
 * Rebases the checkout onto `origin/<trunk>`. A clean tree is required, and a
 * conflicting rebase is aborted, leaving the checkout as it was. Off trunk,
 * then force-updates `origin/<branch>` if the branch has an upstream.
 */
export function helmPull(cwd: string): HelmSyncResult {
	return logged(cwd, "pull", () => pull(cwd));
}

function pull(cwd: string): HelmSyncResult {
	const { trunk, branch } = syncTarget(cwd, "pull");
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
	if (branch !== trunk) {
		const pushed = pushBranchUpstream(cwd, branch, "pull");
		if (pushed) output.push(pushed);
	}
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

/** A commit in a range, such as one a remote branch has over the local trunk. */
export interface HelmBranchCommit {
	hash: string;
	subject: string;
	author: string;
	at: number;
}

/** Up to `max` commits in `range`, newest first. */
export function commitLog(cwd: string, range: string, max: number): HelmBranchCommit[] {
	const log = gitOutput(cwd, ["log", `-${max}`, "--format=%h%x1f%s%x1f%an%x1f%ct", range]);
	if (!log) return [];
	return log.split("\n").map((line) => {
		const [hash = "", subject = "", author = "", ct = "0"] = line.split("\x1f");
		return { hash, subject, author, at: Number(ct) * 1000 };
	});
}

/** The checkout's commits over `origin/<trunk>`, and whether Squash may run. */
export interface HelmUnpushed {
	trunk: string;
	branch: string;
	ahead: number;
	behind: number;
	/** Ahead of `origin/<trunk>`, each marked whether the upstream has it (null without one). */
	commits: (HelmBranchCommit & { pushed: boolean | null })[];
	/** On `origin/<trunk>` but not HEAD: what Pull brings in. */
	incoming: HelmBranchCommit[];
	/** Off trunk, the upstream's commits HEAD lacks, which a push would overwrite. */
	replaced: HelmBranchCommit[];
	/** The shared history, from where HEAD meets `origin/<trunk>`. */
	history: HelmBranchCommit[];
	squashable: boolean;
	blocker: string | null;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function countCommits(cwd: string, range: string): number {
	return Number(gitOutput(cwd, ["rev-list", "--count", range]) ?? 0);
}

/**
 * Fetches `origin/<trunk>` and lists the commits HEAD has over it, newest
 * first. An active dive does not refuse the read; it is Squash's blocker.
 */
export function helmUnpushed(cwd: string): HelmUnpushed {
	const rc = readNosediveRc(cwd);
	const trunk = bridgeTrunk(rc);
	const branch = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
	fetchTrunk(cwd, trunk);
	const ahead = countCommits(cwd, `origin/${trunk}..HEAD`);
	const behind = countCommits(cwd, `HEAD..origin/${trunk}`);
	const blocker = readActiveDiveId(rc.workspaceDir)
		? "Can't squash during a dive: land, pack or bail it first."
		: behind > 0
			? `Squash needs a Pull first: origin/${trunk} has ${plural(behind, "commit")} this checkout lacks.`
			: ahead < 2
				? "Nothing to squash."
				: null;
	const upstream = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "@{u}"]);
	const onUpstream = (hash: string): boolean | null =>
		upstream ? runGit(cwd, ["merge-base", "--is-ancestor", hash, "@{u}"]).status === 0 : null;
	const base = gitOutput(cwd, ["merge-base", "HEAD", `origin/${trunk}`]);
	return {
		trunk,
		branch,
		ahead,
		behind,
		commits: commitLog(cwd, `origin/${trunk}..HEAD`, 100).map((c) => ({
			...c,
			pushed: onUpstream(c.hash),
		})),
		incoming: commitLog(cwd, `HEAD..origin/${trunk}`, 50),
		replaced: upstream && branch !== trunk ? commitLog(cwd, "HEAD..@{u}", 50) : [],
		history: base ? commitLog(cwd, base, 20) : [],
		squashable: blocker === null,
		blocker,
	};
}

/**
 * Makes the commits in `origin/<trunk>..HEAD` one commit with `message`,
 * logged. Refused while a dive is active, with uncommitted changes, while
 * behind `origin/<trunk>`, or with fewer than two commits. Off trunk, then
 * force-updates `origin/<branch>` if the branch has an upstream.
 */
export function helmSquash(cwd: string, message: string): HelmSyncResult {
	return logged(cwd, "squash", () => squash(cwd, message));
}

function squash(cwd: string, message: string): HelmSyncResult {
	const { trunk, branch } = syncTarget(cwd, "squash");
	if (!message.trim()) throw new HelmRequestError(400, "a squash needs a commit message");
	if (gitRun(cwd, ["status", "--porcelain", "--untracked-files=no"], "failed to read status"))
		throw new HelmRequestError(
			409,
			"cannot squash with uncommitted changes; commit or discard them",
		);
	fetchTrunk(cwd, trunk);
	if (runGit(cwd, ["merge-base", "--is-ancestor", `origin/${trunk}`, "HEAD"]).status !== 0)
		throw new HelmRequestError(
			409,
			`origin/${trunk} has commits this checkout lacks; pull first, then squash`,
		);
	const count = countCommits(cwd, `origin/${trunk}..HEAD`);
	if (count < 2)
		throw new HelmRequestError(
			409,
			`nothing to squash: ${plural(count, "commit")} ahead of origin/${trunk}`,
		);
	const head = gitRun(cwd, ["rev-parse", "HEAD"], "failed to read HEAD");
	gitRun(cwd, ["reset", "--soft", `origin/${trunk}`], "failed to reset");
	const committed = runGit(cwd, ["commit", "--cleanup=whitespace", "-F", "-"], { input: message });
	if (committed.status !== 0) {
		gitRun(cwd, ["reset", "--soft", head], "failed to restore HEAD");
		throw new HelmRequestError(409, `squash commit failed; nothing changed:\n${said(committed)}`);
	}
	if (branch === trunk)
		return {
			output: [
				said(committed),
				`${count} commits became one; nothing was pushed; Push publishes it`,
			]
				.filter(Boolean)
				.join("\n"),
		};
	const output = [said(committed), `${count} commits became one`];
	const pushed = pushBranchUpstream(cwd, branch, "squash");
	output.push(pushed ?? `nothing was pushed: ${branch} has no upstream; Push publishes it`);
	return { output: output.filter(Boolean).join("\n") };
}

/**
 * Off trunk, after a rewrite, force-updates `origin/<branch>` with a lease, as
 * Push does, so the upstream never lags the checkout. Returns null without an
 * upstream; a rejected push throws, saying the `action` itself succeeded.
 */
function pushBranchUpstream(cwd: string, branch: string, action: string): string | null {
	if (runGit(cwd, ["rev-parse", "--abbrev-ref", "@{u}"]).status !== 0) return null;
	const pushed = runGit(cwd, ["push", "--force-with-lease", "origin", `HEAD:refs/heads/${branch}`]);
	if (pushed.status !== 0)
		throw new HelmRequestError(
			409,
			`${action} succeeded, but the push to origin/${branch} was rejected:\n${said(pushed)}`,
		);
	return [said(pushed), `force-updated origin/${branch} to match`].filter(Boolean).join("\n");
}
