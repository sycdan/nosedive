import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { injectDocsIntoBacklogMemo } from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { resolveBridgeDocRef } from "../lib/diveScopes.js";

function parseInjectRefs(args: string[]): string[] {
	const refs: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--inject") {
			const value = args[i + 1];
			if (!value) throw new Error("--inject requires a value");
			refs.push(value);
			i += 1;
			continue;
		}
		if (arg.startsWith("--inject=")) {
			const value = arg.slice("--inject=".length);
			if (!value) throw new Error("--inject requires a value");
			refs.push(value);
			continue;
		}
		throw new Error(`unexpected update-backlog argument: ${arg}`);
	}
	return refs;
}

function updateBacklog(args: string[], io: CommandIo): void {
	const injectRefs = parseInjectRefs(args);

	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("update-backlog requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	// Resolve every ref before writing anything, so a typo in the second
	// --inject cannot leave the first one half-applied.
	const targets: KbDoc[] = injectRefs.map((ref) => resolveBridgeDocRef(rc.bridgeDir, kbDocs, ref));
	injectDocsIntoBacklogMemo(rc, kbDocs, targets, io);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(updateBacklog, args);
}
