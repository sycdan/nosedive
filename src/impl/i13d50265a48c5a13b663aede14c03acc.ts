import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { nukeConfig, nukeWorkspace, parseNukeOptions } from "../lib/nukeApply.js";
import { printCommandHelp } from "../lib/packageBacklog.js";

function nuke(args: string[], io: CommandIo): void {
	const options = parseNukeOptions(args);
	if (options.help) {
		printCommandHelp("nuke", io);
		return;
	}

	if (!options.config && !options.workspace) {
		throw new Error("nosedive nuke is destructive; rerun with --config or --workspace");
	}

	if (options.config) nukeConfig(io);
	if (options.workspace) nukeWorkspace(io);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(nuke, args);
}
