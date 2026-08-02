import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { checkDiveWip, printDiveWipFailure } from "../lib/gitState.js";

function prePushHook(_args: string[], io: CommandIo): void {
	const failures = checkDiveWip();
	if (failures.length === 0) return;
	printDiveWipFailure(failures, io);
	io.setExitCode(1);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(prePushHook, args);
}
