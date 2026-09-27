import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { makeDeck } from "../lib/decks.js";

const MAKERS: Record<string, (name: string, io: { log(message: string): void }) => void> = {
	deck: (name, io) => void makeDeck(process.cwd(), name, io),
};

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => {
		const [thing, ...words] = commandArgs;
		const make = thing === undefined ? undefined : MAKERS[thing];
		if (!make) throw new Error(`make knows how to make: ${Object.keys(MAKERS).join(", ")}`);
		const name = words.join(" ").trim();
		if (!name) throw new Error(`make ${thing} requires a name`);
		make(name, io);
	}, args);
}
