import {
	appendFailedAttempt,
	coldStart,
	parseColdStartUsage,
	resolveEffortLadder,
} from "../lib/agentRunner.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import {
	assertDropTargetReached,
	dropTargetDate,
	parseDropArgs,
	resolveDropEffort,
	todayIsoDate,
} from "../lib/drop.js";
import {
	parseEffortRange,
	readPromptBody,
	renderDropPrompt,
	resolvePromptDoc,
	resolveRunnerUsage,
} from "../lib/dropPrompt.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";

/**
 * A cold start can take minutes and says nothing while it runs, so progress
 * goes out as it happens rather than in the captured result the pilot would
 * only see once every tier had already been paid for.
 */
function progress(line: string): void {
	process.stderr.write(`drop: ${line}\n`);
}

export function run(args: string[], runtime: ImplRuntime): ImplCommandOutput {
	const options = parseDropArgs(args);
	const rc = readNosediveRc(runtime.cwd);
	if (!rc.kbDir) throw new Error("drop requires a configured kb directory");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const effort = resolveDropEffort(kbDocs, options.name);
	const target = dropTargetDate(effort);
	const today = todayIsoDate();
	assertDropTargetReached(effort, target, today);

	if (!runtime.commandDoc) throw new Error("drop cannot read its own command doc");
	const range = parseEffortRange(runtime.commandDoc.path);
	const models = resolveEffortLadder(rc, range.minimum, range.maximum);
	const usage = resolveRunnerUsage(kbDocs, rc);
	const promptDoc = resolvePromptDoc(kbDocs, rc, "drop");

	let prompt = renderDropPrompt(readPromptBody(promptDoc), effort, target, today);
	for (const [index, model] of models.entries()) {
		const effortLevel = range.minimum + index;
		progress(`effort ${effortLevel}, ${model}`);
		const attempt = {
			...coldStart(parseColdStartUsage(usage, model), prompt, rc.bridgeDir),
			effort: effortLevel,
			model,
		};
		if (attempt.exitCode === 0) {
			progress(`effort ${effortLevel} dropped ${effort.name}`);
			return { stdout: attempt.stdout, stderr: "", exitCode: 0 };
		}
		progress(`effort ${effortLevel} failed with exit ${attempt.exitCode}`);
		prompt = appendFailedAttempt(prompt, attempt);
	}

	return {
		stdout: "",
		stderr: `nosedive: ${effort.name} was not dropped: every effort from ${range.minimum} to ${range.maximum} failed\n`,
		exitCode: 1,
	};
}
