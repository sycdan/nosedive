import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { NO_ACTIVE_DIVE_ERROR_ID } from "../lib/constants.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { hydratedScopedRepoPath, readWorkspaceDiveMarker } from "../lib/gitState.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import {
	collectDiveGates,
	collectLandGates,
	gateRepoContext,
	LandGate,
	resolveGateScript,
	runLandGates,
} from "../lib/landGates.js";
import { resolveEffortDoc } from "../lib/repoEffortScopes.js";

interface TestArgs {
	gateRef?: string;
	full: boolean;
}

function parseTestArgs(args: string[]): TestArgs {
	let gateRef: string | undefined;
	let full = false;
	for (const arg of args) {
		if (arg === "--full") {
			full = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown test option: ${arg}`);
		if (gateRef !== undefined) throw new Error(`unexpected test argument: ${arg}`);
		gateRef = arg;
	}
	if (gateRef !== undefined && full) {
		throw new Error("--full runs the whole gate set, so it cannot name a single gate");
	}
	return { gateRef, full };
}

function gateLabel(gate: LandGate): string {
	return `${gate.doc.name || gate.doc.id} (${gate.doc.id})`;
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(test, args);
}

async function test(args: string[], io: CommandIo): Promise<void> {
	const { gateRef, full } = parseTestArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("test requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);

	/**
	 * Every form needs a dive. Naming one gate is the exception that proves it:
	 * the gate is already chosen, so the dive is only context for `ctx.diveId`,
	 * and refusing there would make the one form that needs no selection the
	 * hardest to run.
	 */
	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	const dive =
		marker.id !== undefined
			? kbDocs.find((doc) => doc.id === marker.id && doc.kind === "dive")
			: undefined;
	if (gateRef === undefined && !dive) throw new Error(NO_ACTIVE_DIVE_ERROR_ID);

	const gates = gateRef !== undefined ? [namedGate(gateRef, kbDocs, rc.bridgeDir)] : undefined;
	const selected = gates ?? selectDiveGates(dive!, kbDocs, rc, full);

	if (selected.length === 0) {
		/**
		 * Zero gates is the one verdict a test command must never report as
		 * success: it would teach a pilot that green means checked when it means
		 * unchecked. The minted error doc that explains this properly belongs to
		 * its own slice; this is the honest interim.
		 */
		io.writeErr(
			full
				? "test: no gates are reachable from this dive, its feat, or its scoped repos.\n"
				: `test: this dive links no gates. Add a rel: land.gate link to a runnable gate, or run with --full to widen the search.\n`,
		);
		io.setExitCode(1);
		return;
	}

	const hydrated: { repoId: string; path: string }[] = [];
	if (rc.workspaceDir) {
		for (const repo of kbDocs.filter((candidate) => candidate.kind === "repo")) {
			const resolved = hydratedScopedRepoPath(
				kbDocs,
				{ repoId: repo.id, readOnly: false },
				rc.bridgeDir,
				rc.workspaceDir,
			);
			if (resolved.failure) throw new Error(`test refuses: ${resolved.failure.reasons.join("; ")}`);
			if (resolved.path) hydrated.push({ repoId: repo.id, path: resolved.path });
		}
	}

	const outcome = await runLandGates(selected, {
		// The gates' own streams, as they write them. Nothing is replayed
		// afterwards -- a pilot watching a gate run has already seen it.
		sink: { out: (text) => io.writeOut(text), err: (text) => io.writeErr(text) },
		context: {
			bridgeRoot: rc.bridgeDir,
			diveId: dive?.id ?? "",
			repos: gateRepoContext(hydrated, kbDocs, rc.bridgeDir),
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

/** A gate named by uuid, run whatever it is attached to. */
function namedGate(id: string, kbDocs: KbDoc[], bridgeDir: string): LandGate {
	const doc = kbDocs.find((candidate) => candidate.id === id);
	if (!doc) throw new Error(`gate not found: ${id}`);
	return {
		doc,
		scriptPath: resolveGateScript(doc, bridgeDir),
		gateHeight: 0,
		flaky: false,
		introducedBy: doc,
		shadowedBy: [],
	};
}

/**
 * `--full` selects exactly what `land` would, from the same three roots, so a
 * clean `test --full` is a truthful preview of a land rather than a similar
 * one. Without it, only the dive's own gates.
 */
function selectDiveGates(
	dive: KbDoc,
	kbDocs: KbDoc[],
	rc: ReturnType<typeof readNosediveRc>,
	full: boolean,
): LandGate[] {
	if (!full) return collectDiveGates(dive, kbDocs, rc.bridgeDir);
	const effort = dive.effortRef ? resolveEffortDoc(kbDocs, rc, dive.effortRef) : undefined;
	const roots = [
		dive,
		...(effort ? [effort] : []),
		...dive.scopes
			.map((scope) => kbDocs.find((doc) => doc.id === scope.repoId))
			.filter((doc): doc is KbDoc => doc !== undefined),
	];
	return collectLandGates(roots, kbDocs, rc.bridgeDir);
}
