import { basename } from "node:path";

import type { HelmDeck, HelmLink } from "./helm.js";
import { readActiveDiveId, type KbDoc } from "./kbDocs.js";
import { bridgeView, viewDecks } from "./helmView.js";
import { KB_FEAT_ID } from "./shipZerostars.js";

const FEAT_ROLE = /(^|\.)(feat|effort)$/;

/**
 * The deck helm has picked and what hangs off it: the bridge, its bridge deck
 * -- the backlog memo -- and the other decks, for the picker; the picked deck
 * and the feats it links (the kb feat first). With no dive the pilot picks,
 * the bridge deck by default; on one the deck is the dive's `meta.deck`, or
 * the bridge deck when it names none, and cannot be changed. All read
 * through the view, so a dive that scopes the bridge shows what it has
 * written.
 */
export function helmDecks(
	cwd: string,
	asked?: string,
): {
	bridge: { id?: string; name: string };
	bridgeDeck?: HelmDeck;
	decks: HelmDeck[];
	deck?: string;
	locked: boolean;
	feats: HelmLink[];
	diving: boolean;
} {
	const view = bridgeView(cwd);
	const { rc, docs } = view;
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const bridgeDoc = rc.bridge ? byId.get(rc.bridge) : undefined;
	const card = (id: string): HelmDeck => {
		const doc = byId.get(id);
		if (!doc) return { id, name: id, kind: "missing", gist: `no kb doc ${id}` };
		return { id, name: doc.name, kind: doc.kind, gist: doc.gist, title: doc.h1 };
	};
	const decks = viewDecks(view).filter((id) => id !== rc.backlog);
	const pickable = new Set([rc.backlog, ...decks].filter(Boolean));
	const activeId = readActiveDiveId(rc.workspaceDir);
	const diveDeck = activeId ? byId.get(activeId)?.metaScalars.deck : undefined;
	const wanted = activeId ? diveDeck : asked;
	const deckId = wanted && pickable.has(wanted) ? wanted : rc.backlog;
	const deck = deckId ? byId.get(deckId) : undefined;
	const feats = (deck?.links ?? [])
		.filter((link) => FEAT_ROLE.test(link.rel ?? ""))
		.map((link) => ({ link, doc: byId.get(link.id) }))
		.filter((entry): entry is { link: KbDoc["links"][number]; doc: KbDoc } => !!entry.doc)
		.sort((a, b) => Number(b.doc.id === KB_FEAT_ID) - Number(a.doc.id === KB_FEAT_ID))
		.map(({ link, doc }): HelmLink => ({
			type: "doc",
			target: `kb/${doc.id}.md`,
			rel: link.rel,
			id: doc.id,
			name: doc.name,
			kind: doc.kind,
			gist: doc.gist,
			title: doc.h1,
		}));
	return {
		bridge: { id: rc.bridge, name: bridgeDoc?.name ?? basename(rc.bridgeDir) },
		bridgeDeck: rc.backlog ? card(rc.backlog) : undefined,
		decks: decks.map(card),
		deck: deckId,
		locked: Boolean(activeId),
		feats,
		diving: Boolean(activeId),
	};
}
