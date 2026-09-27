import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { parseYamlBlock, readNosediveRc, uuidLike, type NosediveRc } from "./coreParsing.js";
import { namespacedUuid } from "./namespacedUuid.js";
import { writeFileAtomic } from "./renderPlan.js";
import { titleFromSlug } from "./slugs.js";

const DECK_TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The bridge config's `decks:` entries, as a comma string or a YAML list. With
 * none configured the backlog memo is the one deck, so a bridge that has never
 * heard of decks still shows its plan.
 */
export function parseDecks(raw: unknown, backlog: string | undefined): string[] {
	const entries =
		raw === undefined || raw === null || raw === ""
			? []
			: (Array.isArray(raw) ? raw.map(String) : String(raw).split(",")).map((entry) =>
					entry.trim(),
				);
	for (const entry of entries) {
		if (!uuidLike(entry) && !DECK_TAG.test(entry))
			throw new Error(`invalid deck tag in decks: ${JSON.stringify(entry)} (use kebab-case)`);
	}
	if (entries.length > 0) return entries;
	return backlog ? [backlog] : [];
}

export function configuredDecks(rc: NosediveRc): string[] {
	const config = parseYamlBlock(readFileSync(rc.path, "utf8"), rc.path);
	return parseDecks(config.raw.decks, rc.backlog);
}

/** A uuid-like entry is a doc id already; a tag's doc id is uuid5 of the bridge's repo id and the tag. */
export function deckId(rc: NosediveRc, entry: string): string {
	if (uuidLike(entry)) return entry.toLowerCase();
	if (!rc.bridge)
		throw new Error(`deck tag ${entry} needs the bridge config's \`bridge:\` repo id`);
	return namespacedUuid(rc.bridge, entry);
}

function renderDeckDoc(id: string, tag: string, title: string): string {
	return [
		"---",
		"kind: deck",
		`id: ${id}`,
		`name: ${tag}`,
		`gist: "Deck ${tag}"`,
		"---",
		"",
		`# ${title}`,
		"",
	].join("\n");
}

/** Writes and commits the doc of every configured tag that has none. */
export function ensureTagDecks(cwd: string, io: { log(message: string): void }): void {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("decks require a configured kb directory");
	for (const entry of configuredDecks(rc)) {
		if (uuidLike(entry)) continue;
		const id = deckId(rc, entry);
		const path = join(rc.kbDir, `${id}.md`);
		if (existsSync(path)) continue;
		writeFileAtomic(path, renderDeckDoc(id, entry, titleFromSlug(entry)));
		commitBridgeDocs(rc.bridgeDir, `deck(${entry}): created`, [path], io);
	}
}
