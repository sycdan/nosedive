import { formatPath, type NosediveRc } from "./coreParsing.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { gitRun } from "./repoWorkspaceCore.js";

/** The commits a scope's worktree holds past the ref its dive pinned. */
export function commitsAheadOfPin(
	worktreePath: string,
	scopeRef: string,
	repoId: string,
): string[] {
	const commits = gitRun(
		worktreePath,
		["rev-list", "--abbrev-commit", `${scopeRef}..HEAD`],
		`failed to list commits ahead of pin for repo ${repoId}`,
	);
	return commits ? commits.split(/\r?\n/).filter(Boolean) : [];
}

export function headIsStrictlyBehindPin(worktreePath: string, scopeRef: string): boolean {
	const head = gitOutput(worktreePath, ["rev-parse", "HEAD"]);
	if (!head || head === scopeRef) return false;
	return gitOutput(worktreePath, ["merge-base", "--is-ancestor", "HEAD", scopeRef]) !== undefined;
}

/**
 * The dive's own work in its checkout of the bridge (`__self`), oldest first:
 * what `tip` holds beyond the dive's pin that the live bridge (`base`) does
 * not, leaving out merges. Beyond the pin, because the work branch still
 * carries earlier dives' commits, landed into the bridge under other hashes;
 * not in the live bridge, because jump merges it in, nor already there under
 * another hash, so a land retried after a refused push picks nothing twice.
 */
export function ownCommits(repo: string, base: string, tip: string, pin: string): string[] {
	const listed = gitRun(
		repo,
		[
			"rev-list",
			"--reverse",
			"--no-merges",
			"--right-only",
			"--cherry-pick",
			`${base}...${tip}`,
			`^${pin}`,
		],
		`failed to list the commits ${tip} holds beyond ${base} and ${pin}`,
	);
	return listed ? listed.split(/\r?\n/).filter(Boolean) : [];
}

/** Fetches the live bridge's HEAD into a checkout of the bridge and returns that commit. */
export function fetchLiveBridge(bridgeDir: string, checkout: string): string {
	gitRun(checkout, ["fetch", "--quiet", bridgeDir, "HEAD"], "failed to fetch the live bridge");
	return gitRun(checkout, ["rev-parse", "FETCH_HEAD"], "failed to read the live bridge's HEAD");
}

/**
 * Merges the live bridge, as jump leaves it, into the dive's `__self`, so the
 * dive starts with its own record and whatever jump wrote to its feat: work
 * on those docs then never conflicts with the bookkeeping at land. A merge,
 * not a rebase, so the scope's work branch still only moves forward. A
 * conflict is aborted and reported; `__self` stays at its pin.
 */
export function followLiveBridge(
	bridgeDir: string,
	checkout: string,
	io: { err(message: string): void },
): void {
	const head = fetchLiveBridge(bridgeDir, checkout);
	const merged = runGit(checkout, ["merge", "--no-edit", "-m", "Follow the live bridge", head]);
	if (merged.status === 0) return;
	const conflicts = gitOutput(checkout, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
	runGit(checkout, ["merge", "--abort"]);
	io.err(
		`jump: ${formatPath(checkout)} could not take in the live bridge and stays at its pin; ` +
			`these files conflict: ${conflicts.split(/\r?\n/).filter(Boolean).join(", ") || merged.stderr.trim()}`,
	);
}

/**
 * What a dive changed in its checkout of the bridge itself (`__self`) is the
 * bridge's own kb, so land brings the dive's own commits into the live
 * bridge -- before any scope is pushed, so a refusal strands nothing on the
 * work branch -- cherry-picked from the checkout onto the branch the live
 * bridge has checked out, so the bridge push land makes carries them out.
 * Otherwise a root or feat made on the dive never reaches the bridge.
 *
 * Into the live bridge rather than pushed to its remote from the checkout: the
 * live bridge may hold commits of its own that land publishes (a `record.gate`
 * does), and a bridge checked out on a branch other than trunk should receive
 * the dive there, not have it pushed past it. A conflict is aborted, leaving
 * the live bridge as it was, and refused with the files named.
 */
export function bringBridgeScopeIn(
	scopes: Array<{ scope: { repoId: string; ref?: string; workBranch?: string }; path: string }>,
	rc: NosediveRc,
	io: { err(message: string): void },
): void {
	const self = scopes.find(({ scope }) => scope.repoId === rc.bridge);
	if (!self?.scope.ref || !self.scope.workBranch) return;
	const commits = selfOwnCommits(self.path, self.scope.ref, rc);
	if (commits.length === 0) return;
	io.err(`land: bringing the bridge's own scope into the bridge`);
	const picked = runGit(rc.bridgeDir, ["cherry-pick", "--keep-redundant-commits", ...commits]);
	if (picked.status !== 0) {
		const conflicts = gitOutput(rc.bridgeDir, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
		runGit(rc.bridgeDir, ["cherry-pick", "--abort"]);
		throw new Error(
			`land refused: the bridge's own scope does not apply to the bridge at ${formatPath(rc.bridgeDir)}; ` +
				`nothing was pushed. Resolve these in ${formatPath(self.path)} and land again:\n  ` +
				(conflicts.split(/\r?\n/).filter(Boolean).join("\n  ") || picked.stderr.trim()),
		);
	}
	io.err(`land: brought the bridge's own scope into the bridge`);
}

/** The dive's own commits in its `__self` checkout, as `ownCommits` reads them against the live bridge. */
function selfOwnCommits(path: string, pin: string, rc: NosediveRc): string[] {
	gitRun(
		rc.bridgeDir,
		["fetch", "--quiet", path, "HEAD"],
		`failed to fetch ${formatPath(path)} into the bridge`,
	);
	return ownCommits(rc.bridgeDir, "HEAD", "FETCH_HEAD", pin);
}

/**
 * Whether a writable scope has nothing of the dive's to publish. For the
 * bridge's own `__self` that is its own commits, because jump commits its
 * bookkeeping there and the live bridge already holds it; for any other repo
 * it is any commit past the pin.
 */
export function scopeUnchanged(
	scope: { repoId: string; ref?: string },
	path: string,
	rc: NosediveRc,
): boolean {
	if (scope.repoId === rc.bridge) return selfOwnCommits(path, scope.ref!, rc).length === 0;
	return commitsAheadOfPin(path, scope.ref!, scope.repoId).length === 0;
}
