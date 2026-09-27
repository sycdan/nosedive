import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { startHelmServer } from "../lib/helm.js";

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(async (commandArgs, io) => {
		if (commandArgs.length > 0)
			throw new Error(`helm takes no arguments: ${commandArgs.join(" ")}`);
		const server = await startHelmServer(process.cwd(), io);
		io.log(`helm: ${server.url}`);
		io.log("Ctrl+C to stop.");
		await new Promise<void>((resolveStop) => {
			const stop = () => void server.close().then(resolveStop);
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
	}, args);
}
