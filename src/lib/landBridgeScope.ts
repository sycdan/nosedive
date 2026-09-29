import { formatPath, type NosediveRc } from "./coreParsing.js";
import { gitOutput, runGit } from "./gitProcess.js";
import type { KbDoc } from "./kbDocs.js";
import { gitRun } from "./repoWorkspaceCore.js";

/**
 * What a dive changed in its checkout of the bridge itself (`__self`) is the
 * bridge's own kb, so land publishes it to the bridge's trunk -- the `trunk`
 * its repo doc names -- as well as to the scope's work branch: otherwise a deck
 * or a feat made on the dive never reaches the live bridge.
 *
 * The same move as helm's Push: rebase onto the published trunk, then a plain
 * fast-forward push, never a force. It runs after the scopes are pushed and
 * before land syncs the live bridge, whose fast-forward then picks it up --
 * which is why a live bridge holding commits of its own is refused first.
 */
export function publishBridgeScope(
	scopes: Array<{ scope: { repoId: string }; path: string }>,
	rc: NosediveRc,
	kbDocs: KbDoc[],
	upstream: string,
	io: { err(message: string): void },
): void {
	const self = scopes.find(({ scope }) => scope.repoId === rc.bridge);
	if (!self) return;
	const trunk = kbDocs.find((doc) => doc.id === rc.bridge)?.repoBaseBranch ?? "main";
	const ahead = gitOutput(rc.bridgeDir, ["rev-list", "--count", `${upstream}..HEAD`]);
	if (ahead && ahead !== "0")
		throw new Error(
			`land refused: the bridge has ${ahead} commit(s) not on ${upstream}, and this dive publishes to its ${trunk}; push or drop them first`,
		);

	const url = gitRun(
		self.path,
		["config", "--get", "remote.origin.url"],
		"failed to resolve the bridge's origin",
	);
	io.err(`land: publishing the bridge's own scope to ${trunk}`);
	gitRun(self.path, ["fetch", url, trunk], `failed to fetch ${trunk} for the bridge's own scope`);
	const rebase = runGit(self.path, ["rebase", "FETCH_HEAD"]);
	if (rebase.status !== 0) {
		const conflicts = gitOutput(self.path, ["diff", "--name-only", "--diff-filter=U"]) ?? "";
		runGit(self.path, ["rebase", "--abort"]);
		throw new Error(
			`land refused: the bridge's own scope does not rebase onto ${trunk} in ${formatPath(self.path)}; resolve these and land again:\n  ${conflicts.split(/\r?\n/).filter(Boolean).join("\n  ")}`,
		);
	}
	gitRun(self.path, ["push", url, `HEAD:refs/heads/${trunk}`], `failed to fast-forward ${trunk}`);
	io.err(`land: published the bridge's own scope to ${trunk}`);
}
