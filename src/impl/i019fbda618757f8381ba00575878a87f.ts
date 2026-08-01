import { dumpBacklogMemo } from "../lib/commands.js";
import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(dumpBacklogMemo, args);
}
