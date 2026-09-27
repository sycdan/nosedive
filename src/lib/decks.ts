import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDocument } from "yaml";

import { commitBridgeDocs } from "./commitBridgeDocs.js";
import {
	formatPath,
	parseYamlBlock,
	readNosediveRc,
	uuidLike,
	type NosediveRc,
} from "./coreParsing.js";
import { namespacedUuid } from "./namespacedUuid.js";
import { writeFileAtomic } from "./renderPlan.js";
import { slugFromGist, titleFromSlug } from "./slugs.js";

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

/**
 * Makes a deck from a name: its slug is the tag, the doc sits at the tag's
 * deterministic id, and the tag joins `decks:` unless it is listed already --
 * all in one commit. With no `decks:` yet, the backlog is written in first, so
 * adding a deck never hides the one the bridge was already showing.
 */
export function makeDeck(cwd: string, name: string, io: { log(message: string): void }): string {
	const slug = slugFromGist(name, 60);
	if (!slug) throw new Error(`deck name has nothing to slug: ${JSON.stringify(name)}`);
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("make deck requires a configured kb directory");
	const id = deckId(rc, slug);
	const path = join(rc.kbDir, `${id}.md`);
	if (existsSync(path)) throw new Error(`deck ${slug} already exists: ${formatPath(path)}`);

	const decks = configuredDecks(rc);
	const listed = decks.includes(slug);
	if (!listed) {
		const config = parseDocument(readFileSync(rc.path, "utf8"));
		// Written as a comma string whatever form it was read in: `seed` carries
		// over the config keys it does not own only when they are scalars.
		config.set("decks", [...decks, slug].join(", "));
		writeFileAtomic(rc.path, String(config));
	}
	const title = name.trim() === slug ? titleFromSlug(slug) : name.trim();
	writeFileAtomic(path, renderDeckDoc(id, slug, title));
	io.log(`Made ${formatPath(path)}`);
	commitBridgeDocs(rc.bridgeDir, `deck(${slug}): created`, listed ? [path] : [path, rc.path], io);
	return id;
}

/** Makes the doc of every configured tag that has none. */
export function ensureTagDecks(cwd: string, io: { log(message: string): void }): void {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("decks require a configured kb directory");
	for (const entry of configuredDecks(rc)) {
		if (uuidLike(entry) || existsSync(join(rc.kbDir, `${deckId(rc, entry)}.md`))) continue;
		makeDeck(cwd, entry, io);
	}
}
