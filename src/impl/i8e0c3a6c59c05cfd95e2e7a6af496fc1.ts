import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { branchWorktree, bridgeTrunk } from "../lib/helmBranch.js";
import { helmConfigNotes } from "../lib/helmPicker.js";
import { startHelmServer } from "../lib/helmServer.js";

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(async (commandArgs, io) => {
		if (commandArgs.length > 1)
			throw new Error(`helm takes at most one <branch>: ${commandArgs.join(" ")}`);
		const [branch] = commandArgs;
		const rc = branch ? readNosediveRc(process.cwd()) : undefined;
		const dir = rc ? branchWorktree(rc.bridgeDir, branch!, bridgeTrunk(rc), io) : process.cwd();
		const server = await startHelmServer(dir);
		io.log(`helm: ${server.url}`);
		for (const note of helmConfigNotes(dir)) io.log(note);
		io.log("Ctrl+C to stop.");
		await new Promise<void>((resolveStop) => {
			const stop = () => void server.close().then(resolveStop);
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
	}, args);
}
