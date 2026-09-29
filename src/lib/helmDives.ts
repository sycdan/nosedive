import { readNosediveRc } from "./coreParsing.js";
import { configuredDecks } from "./decks.js";
import { findDocs } from "./find.js";
import { loadKbDocs, readActiveDiveId, type KbDoc } from "./kbDocs.js";

export interface HelmDiveCard {
	id: string;
	title: string;
	gist: string;
	feat?: string;
	repos: string[];
	diver?: string;
}

function card(dive: KbDoc, byId: Map<string, KbDoc>): HelmDiveCard {
	const feat = dive.featRef ? byId.get(dive.featRef) : undefined;
	return {
		id: dive.id,
		title: dive.h1 ?? dive.name,
		gist: dive.gist,
		feat: feat?.name,
		repos: dive.scopes.map((scope) => byId.get(scope.repoId)?.name ?? scope.repoId),
		diver: dive.metaScalars.diver || undefined,
	};
}

/**
 * The dives any deck reaches that are still dives -- for each deck, the
 * selection `nosedive find dive` makes from the backlog, narrowed by its term
 * -- and the active one.
 */
export function helmDives(
	cwd: string,
	term?: string,
): { active: HelmDiveCard | null; dives: HelmDiveCard[] } {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("helm requires a configured kb directory");
	const docs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const reached = new Map<string, KbDoc>();
	for (const deckId of configuredDecks(rc)) {
		const deck = byId.get(deckId);
		if (!deck) continue;
		for (const dive of findDocs(deck, docs, "dive", term || undefined, rc.bridgeDir, {
			scopeIds: new Set(),
			kinds: ["dive"],
		}))
			reached.set(dive.id, dive);
	}
	const activeId = readActiveDiveId(rc.workspaceDir);
	const active = activeId ? byId.get(activeId) : undefined;
	return {
		active: active ? card(active, byId) : null,
		dives: [...reached.values()].map((dive) => card(dive, byId)),
	};
}
