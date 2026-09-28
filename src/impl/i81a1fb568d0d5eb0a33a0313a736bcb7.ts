import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { makeDeck } from "../lib/decks.js";

/**
 * The deck kind's crud-script mints through this: `--root <repo>` is the repo
 * the deck kind resolved from, an optional `--name <tag>` names it, and the
 * remaining words are its gist.
 */
export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => {
		const [flag, root, ...rest] = commandArgs;
		if (flag !== "--root" || !root) throw new Error("the deck crud impl needs --root <repo>");
		const named = rest[0] === "--name";
		makeDeck(root, rest.slice(named ? 2 : 0).join(" "), io, named ? rest[1] : undefined);
	}, args);
}
