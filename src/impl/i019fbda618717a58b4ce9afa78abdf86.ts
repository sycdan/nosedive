import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { packageRoot } from "../lib/packageBacklog.js";
import {
	ProverHostRequest,
	assertProverRecordable,
	findAssertionDoc,
	parseProveArgs,
	printProofFailure,
	proofRunTempDir,
	readProverHostResult,
	recordProofResult,
	resolveProverArtifact,
} from "../lib/proveCore.js";
import { cleanGitEnv, writeFileAtomic } from "../lib/renderPlan.js";

async function prove(args: string[], io: CommandIo): Promise<void> {
	const options = parseProveArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const assertion = findAssertionDoc(kbDocs, options.assertionId);
	const proverPath = resolveProverArtifact(rc.bridgeDir, rc.kbDir, assertion);
	const runDir = proofRunTempDir();
	const requestPath = join(runDir, "request.json");
	const resultPath = join(runDir, "result.json");
	const cliPath = join(packageRoot(), "dist", "cli.js");

	const request: ProverHostRequest = {
		bridgeDir: rc.bridgeDir,
		kbDir: rc.kbDir,
		workspaceDir: rc.workspaceDir,
		assertionId: assertion.id,
		assertionName: assertion.name,
		assertionPath: assertion.path,
		proverPath,
		resultPath,
		verbose: options.verbose,
	};
	writeFileAtomic(requestPath, `${JSON.stringify(request, null, 2)}\n`);

	const child = spawnSync(process.execPath, [cliPath, "_prove-host", requestPath], {
		cwd: rc.bridgeDir,
		encoding: "utf8",
		env: cleanGitEnv(),
	});
	if (child.stdout) io.writeOut(child.stdout);
	if (child.stderr) io.writeErr(child.stderr);

	const result = readProverHostResult(resultPath);
	if (result.status !== 0 || child.status !== 0) {
		printProofFailure(assertion, result, child.status, io);
		io.setExitCode(1);
		return;
	}

	if (options.verbose && assertion.gist) io.log(`Gist: ${assertion.gist}`);

	if (options.record) {
		const dirty = Object.entries(result.inputs).filter(([, input]) => input.dirty);
		if (dirty.length > 0) {
			throw new Error(
				`refusing to record proof because accessed repo(s) are dirty: ${dirty
					.map(([repoId]) => repoId)
					.join(", ")}`,
			);
		}
		assertProverRecordable(rc.bridgeDir, proverPath);
		recordProofResult(assertion.path, result);
		io.log(`Proof recorded: ${assertion.id}`);
	} else {
		io.log(`Proof passed: ${assertion.id}`);
	}
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(prove, args);
}
