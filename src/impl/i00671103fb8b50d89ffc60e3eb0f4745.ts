import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { appendLogToDive, readStdinBody } from "../lib/appendLog.js";

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	// Read before the capture opens, so a refused terminal reports as the usage
	// error it is rather than as a command that produced no output.
	const body = readStdinBody();
	const append = (commandArgs: string[], io: CommandIo): void =>
		appendLogToDive(commandArgs, io, body);
	return captureCommand(append, args);
}
