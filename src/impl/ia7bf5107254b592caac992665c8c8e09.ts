import { readNosediveRc } from "../lib/coreParsing.js";
import {
	assertDropTargetReached,
	dropTargetDate,
	parseDropArgs,
	resolveDropEffort,
	todayIsoDate,
} from "../lib/drop.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";

export function run(args: string[], runtime: ImplRuntime): ImplCommandOutput {
	const options = parseDropArgs(args);
	const rc = readNosediveRc(runtime.cwd);
	if (!rc.kbDir) throw new Error("drop requires a configured kb directory");

	const effort = resolveDropEffort(loadKbDocs(rc.kbDir, rc.bridgeDir), options.name);
	const target = dropTargetDate(effort);
	assertDropTargetReached(effort, target, todayIsoDate());

	throw new Error(
		`${effort.name} is droppable as of ${target}, but dropping is not implemented yet`,
	);
}
