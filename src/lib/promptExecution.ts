import {
	appendFailedAttempt,
	coldStart,
	parseColdStartUsage,
	resolveEffortLadder,
} from "./agentRunner.js";
import { readNosediveRc } from "./coreParsing.js";
import { parseEffortRange, resolveRunnerUsage } from "./dropPrompt.js";
import { loadKbDocs } from "./kbDocs.js";

export interface CommandOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function highestConfiguredEffort(efforts: Record<number, string>): number | undefined {
	const levels = Object.keys(efforts).map(Number);
	return levels.length === 0 ? undefined : Math.max(...levels);
}

/** Run an opted-in prompt through the configured runner ladder. */
export function executePrompt(command: string, path: string, prompt: string): void {
	const rc = readNosediveRc(process.cwd());
	const range = parseEffortRange(path, highestConfiguredEffort(rc.agentEfforts));
	if (!range) throw new Error(`${command} does not output a prompt, so --exec cannot run it`);
	const kbDocs = rc.kbDir ? loadKbDocs(rc.kbDir, rc.bridgeDir) : [];
	const usage = resolveRunnerUsage(kbDocs, rc);
	const models = resolveEffortLadder(rc, range.minimum, range.maximum);
	let attemptPrompt = prompt;
	for (const [index, model] of models.entries()) {
		const effort = range.minimum + index;
		process.stderr.write(`${command}: effort ${effort}, ${model}\n`);
		const attempt = {
			...coldStart(parseColdStartUsage(usage, model), attemptPrompt, rc.bridgeDir),
			effort,
			model,
		};
		if (attempt.exitCode === 0) {
			process.stdout.write(attempt.stdout);
			return;
		}
		process.stderr.write(`${command}: effort ${effort} failed with exit ${attempt.exitCode}\n`);
		attemptPrompt = appendFailedAttempt(attemptPrompt, attempt);
	}
	throw new Error(`${command} exhausted every effort from ${range.minimum} to ${range.maximum}`);
}
