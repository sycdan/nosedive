import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { hydratedScopedRepoPath, readWorkspaceDiveMarker } from "../lib/gitState.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { GATE_KINDS, gateRepoContext, resolveGateScript, runLandGates } from "../lib/landGates.js";

function gateId(args: string[]): string {
	if (args.length === 0) throw new Error("run-gate requires a gate id");
	if (args.length > 1) throw new Error(`unexpected run-gate argument: ${args[1]}`);
	return args[0]!;
}

async function runGate(args: string[], io: CommandIo): Promise<void> {
	const id = gateId(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("run-gate requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const doc = kbDocs.find((candidate) => candidate.id === id);
	if (!doc) throw new Error(`gate not found: ${id}`);
	if (!GATE_KINDS.has(doc.kind)) {
		throw new Error(
			`gate ${id} has kind: ${doc.kind}; expected one of ${[...GATE_KINDS].join("|")}`,
		);
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
			if (resolved.failure)
				throw new Error(`run-gate refuses: ${resolved.failure.reasons.join("; ")}`);
			if (resolved.path) hydrated.push({ repoId: repo.id, path: resolved.path });
		}
	}

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	const diveId =
		marker.id && kbDocs.some((candidate) => candidate.id === marker.id && candidate.kind === "dive")
			? marker.id
			: "";
	const outcome = runLandGates(
		[
			{
				doc,
				scriptPath: resolveGateScript(doc, rc.bridgeDir),
				gateHeight: 0,
				flaky: false,
				introducedBy: doc,
				shadowedBy: [],
			},
		],
		{
			clockSeconds: Number.POSITIVE_INFINITY,
			context: {
				bridgeRoot: rc.bridgeDir,
				diveId,
				repos: gateRepoContext(hydrated, kbDocs, rc.bridgeDir),
			},
		},
	);
	const result = outcome.runs[0]!;
	if (result.stdout) io.writeOut(result.stdout);
	if (result.stderr) io.writeErr(result.stderr);
	io.setExitCode(result.status);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(runGate, args);
}
