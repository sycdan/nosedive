import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { printCommandHelp } from "../lib/packageBacklog.js";
import { applyDryRun } from "../lib/renderPlan.js";

function apply(args: string[], io: CommandIo): void {
	if (args.includes("-h") || args.includes("--help")) {
		printCommandHelp("apply", io);
		return;
	}
	if (args.includes("--dry-run")) {
		io.err(
			"warning: `nosedive apply` is deprecated; --dry-run is read-only and will be removed later.",
		);
		applyDryRun(io);
		return;
	}

	throw new Error(
		"nosedive apply is deprecated; check agent instruction files into source control instead",
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(apply, args);
}
