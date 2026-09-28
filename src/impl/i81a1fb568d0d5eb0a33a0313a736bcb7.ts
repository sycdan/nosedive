import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { listDeck } from "../lib/decks.js";

/**
 * The deck kind's post-crud-script calls this once crud has minted a deck:
 * `--root <repo>` is the repo the deck kind resolved from, `--id` the new deck.
 */
export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => {
		const [rootFlag, root, idFlag, id] = commandArgs;
		if (rootFlag !== "--root" || !root || idFlag !== "--id" || !id)
			throw new Error("the deck post-crud impl needs --root <repo> --id <deck>");
		listDeck(root, id, io);
	}, args);
}
