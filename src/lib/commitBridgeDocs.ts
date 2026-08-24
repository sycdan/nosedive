import { relative } from "node:path";

import { commitMessage } from "./commitProvenance.js";
import { toPosixPath } from "./coreParsing.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { gitRun } from "./repoWorkspaceCore.js";

/**
 * Commits the documents a record command just wrote, and nothing else.
 *
 * Without this a minted feat, gate, gate script, repo or note lives only in the
 * pilot's working tree. `jump` and `land` stage their own pathspecs and stash
 * everything else around the push, so those files are carried from one command
 * to the next and reach no clone of the bridge: the sandbox that walks the
 * quickstart ends with a gate nobody else can see.
 *
 * A pathspec commit rather than a bare one, for the same reason `seed` uses
 * one: a pilot's unrelated staged work is theirs, and a command that mints one
 * document must not publish it.
 *
 * It commits and does not push. Pushing would put a network round trip and a
 * new failure mode in front of writing a document, and the next `jump` or
 * `land` carries these commits along with its own.
 */
export function commitBridgeDocs(
	bridgeDir: string,
	subject: string,
	paths: (string | undefined)[],
	io: { log(message: string): void },
	featId?: string,
): void {
	// A bridge that is not a git repository is not broken, it just has nowhere to
	// record this; the document is written either way.
	if (!gitOutput(bridgeDir, ["rev-parse", "--git-dir"])) return;

	const pathspecs = [
		...new Set(
			paths
				.filter((path): path is string => path !== undefined)
				.map((path) => toPosixPath(relative(bridgeDir, path))),
		),
	];
	if (pathspecs.length === 0) return;

	gitRun(bridgeDir, ["add", "--", ...pathspecs], `failed to stage ${subject}`);
	// An empty repository has no HEAD to diff against, and the first commit is
	// never a no-op, so the emptiness check stands in for the comparison.
	const hasHead = gitOutput(bridgeDir, ["rev-parse", "--verify", "HEAD"]) !== undefined;
	if (
		hasHead &&
		runGit(bridgeDir, ["diff", "--cached", "--quiet", "--", ...pathspecs]).status === 0
	)
		return;

	gitRun(
		bridgeDir,
		["commit", "-m", commitMessage(subject, featId), "--", ...pathspecs],
		`failed to commit ${subject}`,
	);
	io.log(`Committed ${subject}`);
}
