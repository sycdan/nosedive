import type { CommandIo } from "./bridgeSetupIo.js";
import type { KbDoc } from "./kbDocs.js";
import { gitOutput } from "./gitProcess.js";
import {
	gateRepoContext,
	type GateOutcome,
	type GateRun,
	type LandGate,
	runLandGates,
} from "./landGates.js";
import { appendLinkToDoc } from "./repoEffortScopes.js";
import { reconcilePushIsolation } from "./repoHardening.js";
import { ensureRepoMarkerExcluded, writeRepoMarker } from "./repoWorktrees.js";
import { hydrateScopeAtPin } from "./scopeHydration.js";

interface HydratedRepo {
	repoId: string;
	path: string;
}

export interface GateRepoSurvey {
	hydrated: HydratedRepo[];
	reports: string[];
}

/**
 * Resolves the selected gates' own scopes, or their declaring docs' scopes when
 * a gate leaves `scopes:` absent. An explicit empty list deliberately overrides
 * the declaring doc. Missing worktrees are created read-only at their resolved
 * commit; existing worktrees are never moved.
 */
export function hydrateGateRepos(
	selected: LandGate[],
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string | undefined,
): GateRepoSurvey {
	const hydrated: HydratedRepo[] = [];
	const reports: string[] = [];
	if (workspaceDir) {
		const scopes = new Map<
			string,
			{ repoId: string; path: string; ref?: string; readOnly: boolean; flags: string[] }
		>();
		for (const gate of selected) {
			const resolved = gate.doc.hasScopes ? gate.doc.scopes : gate.introducedBy.scopes;
			if (resolved.length === 0)
				reports.push(
					`test: gate ${gate.doc.name || gate.doc.id} resolves no repo scopes; ctx.repos is empty for it.\n`,
				);
			for (const scope of resolved) scopes.set(scope.repoId, { ...scope, readOnly: true });
		}
		for (const scope of scopes.values()) {
			const result = hydrateScopeAtPin(scope, kbDocs, bridgeDir, workspaceDir, true);
			if (result.created) {
				// Gates never commit in scoped repos, so newly-created worktrees receive
				// read-only push isolation. Existing worktrees are left entirely alone.
				writeRepoMarker(result.targetPath, result.repoDoc.id);
				ensureRepoMarkerExcluded(result.targetPath, result.repoDoc.id);
				reconcilePushIsolation(result.sourcePath, result.targetPath, true, result.repoDoc.id);
				reports.push(
					`test: hydrated repo ${result.repoDoc.name || result.repoDoc.id} at ${result.commit}.\n`,
				);
			} else {
				const head = gitOutput(result.targetPath, ["rev-parse", "HEAD"]);
				if (head !== result.commit) {
					reports.push(
						`test: repo ${result.repoDoc.name || result.repoDoc.id} is at ${head || "an unknown commit"}, not declared commit ${result.commit}; leaving it unchanged.\n`,
					);
				}
			}
			hydrated.push({ repoId: result.repoDoc.id, path: result.targetPath });
		}
	}
	return { hydrated, reports };
}

export async function runGateSession(
	selected: LandGate[],
	kbDocs: KbDoc[],
	bridgeDir: string,
	diveId: string,
	hydrated: HydratedRepo[],
	io: CommandIo,
): Promise<GateOutcome> {
	const outcome = await runLandGates(selected, {
		// The gates' own streams, as they write them. Nothing is replayed
		// afterwards -- a pilot watching a gate run has already seen it.
		sink: { out: (text) => io.writeOut(text), err: (text) => io.writeErr(text) },
		context: {
			bridgeRoot: bridgeDir,
			diveId,
			repos: gateRepoContext(hydrated, kbDocs, bridgeDir),
		},
	});

	/**
	 * Every gate runs even after one fails, so the summary is the point of the
	 * command: "these three are broken" is actionable where "something is
	 * broken" sends a pilot back to run it again.
	 */
	const failures = outcome.runs.filter((run) => run.status !== 0 && !run.gate.flaky);
	const flaky = outcome.runs.filter((run) => run.status !== 0 && run.gate.flaky);
	// Only worth summarising a set. One gate has already said everything it has
	// to say, and its exit code carries the verdict.
	if (selected.length > 1) {
		io.writeErr(
			`\n${outcome.runs.length} gate(s) in ${(outcome.elapsedMs / 1000).toFixed(1)}s: ` +
				`${outcome.runs.length - failures.length - flaky.length} passed, ${failures.length} failed` +
				`${flaky.length > 0 ? `, ${flaky.length} flaky (not blocking)` : ""}\n`,
		);
		for (const run of failures) {
			io.writeErr(`  FAILED  ${gateLabel(run.gate)} -- exit ${run.status}\n`);
		}
	}
	io.setExitCode(failures.length > 0 ? 1 : 0);
	return outcome;
}

/**
 * Attaches every gate that blocked a run to the dive being worked, so the fix
 * loop is `nosedive test` whichever command found the failure. The gate's own
 * declaration is left where it is -- a `land.gate` on a repo doc stays a
 * `land.gate` there and is rerun from its original home in its own phase.
 *
 * Takes the whole run set rather than a pre-filtered one, so the rule about
 * which failures count lives here and not at each call site. Flaky gates are
 * excluded: a flaky gate reports non-zero as a warning and did not block, so
 * pulling it into the fix loop would ask a diver to chase something that let
 * the run through.
 *
 * Dedup is on the doc being linked, not on the qualifier. A gate the dive
 * already names under any rel is somebody's business already, so a gate failing
 * on three consecutive runs leaves one link and three reports.
 */
export function attachFailedGatesToDive(
	divePath: string,
	diveLinks: KbDoc["links"],
	runs: GateRun[],
): void {
	const linkedIds = new Set(diveLinks.map((link) => link.id));
	for (const { gate, status } of runs) {
		if (status === 0 || gate.flaky) continue;
		if (linkedIds.has(gate.doc.id)) continue;
		appendLinkToDoc(divePath, gate.doc.id, "test.gate");
		linkedIds.add(gate.doc.id);
	}
}

function gateLabel(gate: LandGate): string {
	return `${gate.doc.name || gate.doc.id} (${gate.doc.id})`;
}
