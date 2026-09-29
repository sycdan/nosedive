import { formatPath, type NosediveRc } from "./coreParsing.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { gitRun } from "./repoWorkspaceCore.js";

/**
 * What a dive changed in its checkout of the bridge itself (`__self`) is the
 * bridge's own kb, so once land has pushed that scope to its work branch it
 * also brings the scope's commits into the live bridge: cherry-picked onto the
 * branch the live bridge has checked out, so the bridge push land already
 * makes carries them out. Otherwise a deck or feat made on the dive never
 * reaches the bridge.
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
	upstream: string,
	io: { err(message: string): void },
): void {
	const self = scopes.find(({ scope }) => scope.repoId === rc.bridge);
	if (!self?.scope.ref || !self.scope.workBranch) return;
	const [remote] = upstream.split("/");
	gitRun(
		rc.bridgeDir,
		["fetch", remote!, self.scope.workBranch],
		`failed to fetch ${self.scope.workBranch} into the bridge`,
	);
	const range = `${self.scope.ref}..FETCH_HEAD`;
	if (gitOutput(rc.bridgeDir, ["rev-list", "--count", range]) === "0") return;
	io.err(`land: bringing the bridge's own scope into the bridge`);
	const picked = runGit(rc.bridgeDir, ["cherry-pick", "--keep-redundant-commits", range]);
	if (picked.status !== 0) {
		const conflicts = gitOutput(rc.bridgeDir, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
		runGit(rc.bridgeDir, ["cherry-pick", "--abort"]);
		throw new Error(
			`land refused: the bridge's own scope does not apply to the bridge at ${formatPath(rc.bridgeDir)}; ` +
				`its work is pushed to ${self.scope.workBranch}. Resolve these and land again:\n  ` +
				(conflicts.split(/\r?\n/).filter(Boolean).join("\n  ") || picked.stderr.trim()),
		);
	}
	io.err(`land: brought the bridge's own scope into the bridge`);
}
