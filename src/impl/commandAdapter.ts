import { createCapturingIo, type CapturingCommandIo, type CommandIo } from "../lib/commands.js";
import type { ImplCommandOutput } from "./types.js";

let createCommandIo: (() => CapturingCommandIo) | undefined;

/** Set by the router, which knows whether command stdout is pilot output or a prompt. */
export function setCommandIoFactory(factory: (() => CapturingCommandIo) | undefined): void {
	createCommandIo = factory;
}

export async function captureCommand(
	run: (args: string[], io: CommandIo) => void | Promise<void>,
	args: string[],
): Promise<ImplCommandOutput> {
	const io = createCommandIo?.() ?? createCapturingIo();
	try {
		await run(args, io);
	} finally {
		io.close();
	}
	return io.captured();
}
