import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import {
	collectListDives,
	formatListDivesResult,
	parseListDivesArgs,
} from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { resolveEffortDoc } from "../lib/repoEffortScopes.js";

function listDives(args: string[], io: CommandIo): void {
	const options = parseListDivesArgs(args, io);
	if (!options.effortRef) return;

	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("list-dives requires a configured kb directory");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const effort = resolveEffortDoc(kbDocs, rc, options.effortRef);
	const result = collectListDives(effort, kbDocs, options.includeHistorical);

	if (options.json) io.log(JSON.stringify(result, null, 2));
	else io.log(formatListDivesResult(result, options.includeHistorical));
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(listDives, args);
}
