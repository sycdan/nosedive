import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { makeDeck } from "../lib/decks.js";

/**
 * The deck kind's crud-script mints through this: `--root <repo>` is the repo
 * the deck kind resolved from, and the remaining words are the deck's name.
 */
export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => {
		const [flag, root, ...gist] = commandArgs;
		if (flag !== "--root" || !root) throw new Error("the deck crud impl needs --root <repo>");
		makeDeck(root, gist.join(" "), io);
	}, args);
}
