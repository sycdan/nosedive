import { createCapturingIo, type CommandIo } from "../lib/commands.js";
import type { ImplCommandOutput } from "./types.js";

export async function captureCommand(
	run: (args: string[], io: CommandIo) => void | Promise<void>,
	args: string[],
): Promise<ImplCommandOutput> {
	const io = createCapturingIo();
	try {
		await run(args, io);
	} finally {
		io.close();
	}
	return io.captured();
}
