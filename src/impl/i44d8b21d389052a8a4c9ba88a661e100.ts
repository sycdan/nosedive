import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { bridgeBacklogMemoBody } from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";

function dumpBacklogMemo(args: string[], io: CommandIo): void {
	if (args.length > 0) throw new Error(`unexpected dump-backlog argument: ${args[0]}`);

	const rc = readNosediveRc(process.cwd());
	io.writeOut(bridgeBacklogMemoBody(rc));
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(dumpBacklogMemo, args);
}
