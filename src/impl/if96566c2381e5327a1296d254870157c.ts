import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import {
	collectDeckDives,
	collectKbDives,
	collectListDives,
	formatListDivesResult,
	ListDivesResult,
	localOnlyKbDocIds,
	parseListDivesArgs,
} from "../lib/diveListing.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { resolveFeatDoc } from "../lib/repoFeatScopes.js";

/**
 * A ref is a feat or a deck, told apart by the kind of doc it resolves to: a
 * feat lists the dives it links, a deck lists every dive its feat tree reaches.
 * Anything else is neither, and says so rather than listing nothing.
 */
function scopedDives(
	ref: string | undefined,
	kbDocs: KbDoc[],
	localOnlyIds: ReadonlySet<string>,
	rc: ReturnType<typeof readNosediveRc>,
	includeHistorical: boolean,
): ListDivesResult {
	if (!ref) return collectKbDives(kbDocs, localOnlyIds, includeHistorical);

	const doc = resolveFeatDoc(kbDocs, rc, ref);
	if (doc.kind === "feat") return collectListDives(doc, kbDocs, localOnlyIds, includeHistorical);
	if (doc.kind === "memo") return collectDeckDives(doc, kbDocs, localOnlyIds, includeHistorical);
	throw new Error(`list-dives needs a feat or a deck: ${ref} is a ${doc.kind}`);
}

function listDives(args: string[], io: CommandIo): void {
	const options = parseListDivesArgs(args, io);
	if (options.help) return;

	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("list-dives requires a configured kb directory");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const localOnlyIds = localOnlyKbDocIds(rc.bridgeDir, rc.kbDir);
	const result = scopedDives(options.ref, kbDocs, localOnlyIds, rc, options.includeHistorical);

	if (options.json) io.log(JSON.stringify(result, null, 2));
	else io.log(formatListDivesResult(result, options.includeHistorical));
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(listDives, args);
}
