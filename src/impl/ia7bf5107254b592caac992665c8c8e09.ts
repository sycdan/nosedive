import { readNosediveRc } from "../lib/coreParsing.js";
import {
	assertDropTargetReached,
	dropTargetDate,
	parseDropArgs,
	resolveDropEffort,
	todayIsoDate,
} from "../lib/drop.js";
import {
	readPromptBody,
	renderDropPrompt,
	resolvePromptDoc,
	resolveRunnerUsage,
} from "../lib/dropPrompt.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";

export function run(args: string[], runtime: ImplRuntime): ImplCommandOutput {
	const options = parseDropArgs(args);
	const rc = readNosediveRc(runtime.cwd);
	if (!rc.kbDir) throw new Error("drop requires a configured kb directory");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const effort = resolveDropEffort(kbDocs, options.name);
	const target = dropTargetDate(effort);
	const today = todayIsoDate();
	assertDropTargetReached(effort, target, today);

	const promptDoc = resolvePromptDoc(kbDocs, rc, "drop");
	return { stdout: renderDropPrompt(readPromptBody(promptDoc), effort, target, today), stderr: "", exitCode: 0 };
}
