import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import {
	collectListDives,
	formatListDivesResult,
	parseListDivesArgs,
	resolveEffortPath,
} from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs } from "../lib/kbDocs.js";

function listDives(args: string[], io: CommandIo): void {
	const options = parseListDivesArgs(args, io);
	if (!options.effortRef) return;

	const rc = readNosediveRc(process.cwd());
	if (!rc.backlogDir) throw new Error(".nosediverc is missing backlog");
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");

	const effortPath = resolveEffortPath(options.effortRef, rc.bridgeDir, rc.backlogDir);
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const result = collectListDives(effortPath, rc, kbDocs, options.includeHistorical);

	if (options.json) io.log(JSON.stringify(result, null, 2));
	else io.log(formatListDivesResult(result, options.includeHistorical));
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(listDives, args);
}
