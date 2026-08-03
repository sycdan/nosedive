import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { recordDive } from "../lib/recordDive.js";

function runRecordDive(args: string[], io: CommandIo): void {
	recordDive(args, io);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(runRecordDive, args);
}
