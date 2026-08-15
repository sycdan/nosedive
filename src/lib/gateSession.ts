import type { CommandIo } from "./bridgeSetupIo.js";
import { hydratedScopedRepoPath } from "./gitState.js";
import type { KbDoc } from "./kbDocs.js";
import { gateRepoContext, type LandGate, runLandGates } from "./landGates.js";

interface HydratedRepo {
	repoId: string;
	path: string;
}

export function hydrateGateRepos(
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string | undefined,
): HydratedRepo[] {
	const hydrated: HydratedRepo[] = [];
	if (workspaceDir) {
		for (const repo of kbDocs.filter((candidate) => candidate.kind === "repo")) {
			const resolved = hydratedScopedRepoPath(
				kbDocs,
				{ repoId: repo.id, readOnly: false },
				bridgeDir,
				workspaceDir,
			);
			if (resolved.failure) throw new Error(`test refuses: ${resolved.failure.reasons.join("; ")}`);
			if (resolved.path) hydrated.push({ repoId: repo.id, path: resolved.path });
		}
	}
	return hydrated;
}

export async function runGateSession(
	selected: LandGate[],
	kbDocs: KbDoc[],
	bridgeDir: string,
	diveId: string,
	hydrated: HydratedRepo[],
	io: CommandIo,
): Promise<void> {
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
}

function gateLabel(gate: LandGate): string {
	return `${gate.doc.name || gate.doc.id} (${gate.doc.id})`;
}
