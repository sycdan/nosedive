import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { renderPackageKbBody } from "../lib/gitState.js";

function renderCommand(args: string[], io: CommandIo): void {
	const [id, ...extra] = args;
	if (!id || extra.length > 0) throw new Error("render requires exactly one uuid");
	io.writeOut(renderPackageKbBody(id));
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(renderCommand, args);
}
