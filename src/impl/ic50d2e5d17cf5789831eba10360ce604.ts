import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { findDocs, parseFindArgs } from "../lib/find.js";
import { loadKbDocs } from "../lib/kbDocs.js";

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => {
		const options = parseFindArgs(commandArgs, io);
		if (options.help) return;
		if (!options.role) throw new Error("find requires <role>");
		const rc = readNosediveRc(process.cwd());
		if (!rc.kbDir) throw new Error("find requires a configured kb directory");
		if (!rc.backlog) throw new Error("find requires a configured backlog memo id");
		const docs = loadKbDocs(rc.kbDir, rc.bridgeDir);
		const root = docs.find((doc) => doc.id === rc.backlog);
		if (!root) throw new Error(`bridge backlog memo not found: ${rc.backlog}`);
		for (const doc of findDocs(
			root,
			docs,
			options.role!,
			options.term,
			rc.bridgeDir,
			options.ageMs,
		)) {
			io.log(`${doc.relPath}: ${doc.gist}`);
		}
	}, args);
}
