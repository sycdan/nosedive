import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { collectBacklog, formatBacklog, loadBacklogConfig } from "../lib/packageBacklog.js";

function dumpBacklog(args: string[], io: CommandIo): void {
	const verbose = args.includes("--verbose");
	const unknown = args.filter((arg) => arg !== "--verbose");
	if (unknown.length > 0) throw new Error(`unknown dump-backlog option: ${unknown[0]}`);

	const { backlogDir } = loadBacklogConfig(process.cwd());
	io.log(formatBacklog(collectBacklog(backlogDir), verbose));
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(dumpBacklog, args);
}
