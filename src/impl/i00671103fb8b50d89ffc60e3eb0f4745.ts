import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { appendLogToDive, parseAppendLogArgs, readStdinBody } from "../lib/appendLog.js";

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	// Arguments before stdin, even though `appendLogToDive` parses them again.
	// The parser is what names a body handed over as an argument, and reading
	// first makes that message unreachable: the read blocks before anything has
	// looked at the arguments. A stdin that never ends -- an agent's inherited
	// pipe, which `isTTY` does not catch -- then hangs on a call that was already
	// known to be wrong.
	parseAppendLogArgs(args);
	// Read before the capture opens, so a refused terminal reports as the usage
	// error it is rather than as a command that produced no output.
	const body = readStdinBody();
	const append = (commandArgs: string[], io: CommandIo): void =>
		appendLogToDive(commandArgs, io, body);
	return captureCommand(append, args);
}
