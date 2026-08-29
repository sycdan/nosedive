import { relative } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import { DIVE_BRIEF_HEADING } from "./constants.js";
import { formatPath, toPosixPath } from "./coreParsing.js";
import { renderDiveScratchHandoff } from "./diveScratch.js";
import { DiveWipScope } from "./gitState.js";
import { KbDoc } from "./kbDocs.js";

function scopeLine(entry: { scope: DiveWipScope; path: string }, kbDocs: KbDoc[]): string {
	const repoDoc = kbDocs.find((doc) => doc.id === entry.scope.repoId);
	const name = repoDoc?.name ?? entry.scope.repoId;
	const branch = entry.scope.workBranch;
	return `- ${formatPath(entry.path)} (kb name: ${name})${branch ? ` -- work branch ${branch}` : ""}`;
}

/**
 * Names what jump hydrated and where to commit it, one line per repo that
 * carries a work branch -- the only kind `land` can push. The old wording,
 * "every scoped repo that has a work branch", asked the agent to work the set
 * out for itself from a workspace that does not carry the branch names, and an
 * agent that cannot enumerate a set goes looking for one.
 *
 * A scope with no work branch is hydrated all the same, and is listed rather
 * than omitted: an agent that finds an unexplained checkout in the workspace
 * has to decide for itself what it is for, and deciding is the failure. Saying
 * "reference" makes it inert.
 */
function renderCommitDirective(
	entries: { scope: DiveWipScope; path: string }[],
	kbDocs: KbDoc[],
): string {
	if (entries.length === 0) {
		return "This dive hydrated no scoped repo, so there is nothing to commit.";
	}
	const committable = entries.filter(({ scope }) => scope.workBranch);
	const reference = entries.filter(({ scope }) => !scope.workBranch);

	const sections: string[] = [];
	sections.push(
		committable.length === 0
			? "No hydrated repo names a work branch, so commit nothing."
			: `Commit completed work in these repos, and nowhere else:\n${committable
					.map((entry) => scopeLine(entry, kbDocs))
					.join("\n")}`,
	);
	if (reference.length > 0) {
		sections.push(
			`Reference repos -- read only, commit nothing here:\n${reference
				.map((entry) => scopeLine(entry, kbDocs))
				.join("\n")}`,
		);
	}
	return sections.join("\n\n");
}

/**
 * `jump`'s last word is a handoff: the agent reading this has the workspace but
 * none of the reasoning behind it. Paths are relative to the cwd `jump` ran in
 * so a plain read tool takes them verbatim.
 *
 * How it ends depends on who can read the workspace when the work is done.
 * `pack` resets every scoped worktree to its pin, so it is the only way work in
 * a bridge nobody is watching becomes reachable -- and pure loss in a bridge
 * the pilot has open, where reviewing would then cost a second jump to get the
 * work back. `bridgeIsOnTrunk` draws that line.
 */
export function printWorkDirective(
	dive: KbDoc,
	feat: KbDoc | undefined,
	bridgeDir: string,
	workspaceDir: string,
	packOnDone: boolean,
	hydratedEntries: { scope: DiveWipScope; path: string; commit: string }[],
	kbDocs: KbDoc[],
	io: CommandIo,
): void {
	const divePath = toPosixPath(relative(process.cwd(), dive.path));
	io.log("");
	io.log(`Read the dive at ${divePath} in full and get the gist of its links.`);
	if (feat) {
		io.log(`Read the feat it serves at ${toPosixPath(relative(process.cwd(), feat.path))}`);
	}
	io.log(`Then follow the dive's ${DIVE_BRIEF_HEADING} section.`);
	io.log("Any notes below were logged by prior divers; use for added context.");
	io.log("");
	io.log(`${renderCommitDirective(hydratedEntries, kbDocs)}`);
	io.log("");
	io.log(
		"As you progress, use `nosedive append-log.dive` to record what you did, and what you think is next.",
	);
	io.log("Do not edit the brief or change any scopes.");
	io.log(
		packOnDone
			? "When done, run `nosedive pack` to capture your work and release the dive. "
			: "When done, leave the work in place for the pilot to review. ",
	);
	io.log("Do not run `nosedive land` unless you have been directly instructed to.");
	io.log(renderDiveScratchHandoff(bridgeDir, workspaceDir, dive.id));
}
