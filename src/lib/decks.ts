import { existsSync, readFileSync } from "node:fs";

import { parseDocument } from "yaml";

import {
	baseConfigPath,
	formatPath,
	parseYamlBlock,
	uuidLike,
	type NosediveRc,
} from "./coreParsing.js";
import { writeFileAtomic } from "./renderPlan.js";

/**
 * The bridge config's `decks:`, doc ids as a comma string or a YAML list. With
 * none configured the backlog memo is the one deck, so a bridge that has never
 * heard of decks still shows its plan.
 */
export function parseDecks(raw: unknown, backlog: string | undefined): string[] {
	const entries =
		raw === undefined || raw === null || raw === ""
			? []
			: (Array.isArray(raw) ? raw.map(String) : String(raw).split(",")).map((entry) =>
					entry.trim().toLowerCase(),
				);
	for (const entry of entries) {
		if (!uuidLike(entry))
			throw new Error(`decks lists doc ids, and ${JSON.stringify(entry)} is not one`);
	}
	if (entries.length > 0) return entries;
	return backlog ? [backlog] : [];
}

export function configuredDecks(rc: NosediveRc): string[] {
	const config = parseYamlBlock(readFileSync(rc.path, "utf8"), rc.path);
	return parseDecks(config.raw.decks, rc.backlog);
}

/**
 * Lists a deck in the bridge config at `root` -- what crud does once it has
 * minted a deck -- and returns the config path when it changed it. With no `decks:` yet the
 * backlog is written in first, because an absent `decks:` means the backlog is
 * the one deck, and adding a deck must not hide it.
 */
export function listDeck(root: string, id: string, io: { log(message: string): void }): string[] {
	// The deck kind resolved from this repo, so this repo's own config is where
	// the deck goes. Read it by path: resolving the bridge would walk up, and a
	// bridge checked out as a dive's __self sits inside the live bridge's
	// workspace, so it would find the live one.
	const path = baseConfigPath(root);
	if (!existsSync(path))
		throw new Error(`a deck lives in a bridge, and ${formatPath(root)} is not a nosedive bridge`);
	const text = readFileSync(path, "utf8");
	const scalars = parseYamlBlock(text, path);
	const decks = parseDecks(scalars.raw.decks, scalars.scalars.backlog);
	if (decks.includes(id)) return [];
	const config = parseDocument(text);
	// Written as a comma string whatever form it was read in: `seed` carries
	// over the config keys it does not own only when they are scalars.
	config.set("decks", [...decks, id].join(", "));
	// Unfolded: a deck list is one grep-able line, however long it grows.
	writeFileAtomic(path, config.toString({ lineWidth: 0 }));
	io.log(`Listed ${id} in ${formatPath(path)}`);
	return [path];
}
