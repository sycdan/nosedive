import { basename } from "node:path";

import { sameFeatRef } from "./diveListing.js";
import { helmBranchStatus, type HelmBranchStatus } from "./helmBranch.js";
import { deckLoad, deckRows, type DeckRow } from "./helmDeck.js";
import { helmRepoDoc, type HelmLink } from "./helmLinks.js";
import { bridgeView, type BridgeView } from "./helmView.js";
import { HelmRequestError } from "./helmWrites.js";
import { featChildren, isFeatEdge, rootedScopes } from "./jumpable.js";
import { readActiveDiveId, type KbDoc } from "./kbDocs.js";
import { linkedDoc } from "./repoLinks.js";
import { KB_FEAT_ID } from "./shipZerostars.js";

/** A doc the picker offers. `ref` names it back: its id, or `<repo-quid>:<path>` in another repo. */
export interface HelmPick {
	ref: string;
	id: string;
	repo?: string;
	name: string;
	kind: string;
	gist: string;
	title?: string;
}

/** A `.feat` child in a picked doc's tree, and whether it has `.feat` children to expand into. */
export type HelmFeat = HelmLink & { ref?: string; hasFeats?: boolean };

const refOf = (doc: KbDoc): string => (doc.home ? `${doc.home.repoId}:${doc.relPath}` : doc.id);

function pickOf(doc: KbDoc): HelmPick {
	return {
		ref: refOf(doc),
		id: doc.id,
		...(doc.home ? { repo: doc.home.repoId } : {}),
		name: doc.name,
		kind: doc.kind,
		gist: doc.gist,
		title: doc.h1,
	};
}

/** A doc by the ref the page names it with. */
function pickedDoc(view: BridgeView, ref: string): KbDoc | undefined {
	return view.docs.find((doc) => doc.id === ref) ?? helmRepoDoc(view, ref);
}

const kbFeatFirst = (a: HelmLink, b: HelmLink) => {
	const isKbFeat = (link: HelmLink) => link.type === "doc" && link.id === KB_FEAT_ID;
	return Number(isKbFeat(b)) - Number(isKbFeat(a));
};

function featItems(view: BridgeView, from: KbDoc, byId: Map<string, KbDoc>): HelmFeat[] {
	return from.links
		.filter((link) => isFeatEdge(link.rel))
		.map((link): HelmFeat => {
			const target = linkedDoc(view.rc, from, link, byId);
			if (!target) return { type: "unresolved", target: link.target, rel: link.rel };
			return {
				type: "doc",
				target: link.target,
				rel: link.rel,
				...pickOf(target),
				hasFeats: featChildren(view.rc, target, byId).length > 0,
			};
		})
		.sort(kbFeatFirst);
}

/**
 * The deck picker: every row the backlog reaches without a fetch and the
 * default deck's chain. On a dive the deck is locked to the dive's feat,
 * with its chain when the picker lists it.
 */
export function helmPicker(cwd: string): {
	bridge: { id?: string; name: string; branch: HelmBranchStatus };
	backlog?: DeckRow;
	rows: DeckRow[];
	defaultChain?: string[];
	locked?: Pick<DeckRow, "ref" | "id" | "repo" | "name" | "title" | "gist"> & { chain?: string[] };
} {
	const view = bridgeView(cwd);
	const { rc, docs } = view;
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const bridgeDoc = rc.bridge ? byId.get(rc.bridge) : undefined;
	const { backlog, rows, defaultChain } = deckRows(view);
	const activeId = readActiveDiveId(rc.workspaceDir);
	const ref = activeId ? byId.get(activeId)?.featRef : undefined;
	const feat = ref
		? (docs.find((doc) => sameFeatRef(ref, doc)) ?? helmRepoDoc(view, ref))
		: undefined;
	const lockedRef = feat ? refOf(feat) : defaultChain?.at(-1);
	const lockedRow = rows.find((row) => row.ref === lockedRef);
	const locked = feat ? { ...pickOf(feat), chain: lockedRow?.chain } : lockedRow;
	const missing = rc.backlog
		? {
				ref: rc.backlog,
				id: rc.backlog,
				chain: [],
				path: [],
				name: rc.backlog,
				gist: `no kb doc ${rc.backlog}`,
				container: true as const,
			}
		: undefined;
	return {
		bridge: {
			id: rc.bridge,
			name: bridgeDoc?.name ?? basename(rc.bridgeDir),
			branch: helmBranchStatus(rc.bridgeDir, bridgeDoc?.repoBaseBranch ?? "main"),
		},
		backlog: backlog ?? missing,
		rows,
		defaultChain,
		...(activeId ? { locked } : {}),
	};
}

/** Load: the row a chain of refs leads to, read through crud's read, and the rows below it. */
export function helmPickerLoad(cwd: string, chain: string[]): { rows: DeckRow[] } {
	try {
		return { rows: deckLoad(bridgeView(cwd), chain) };
	} catch (error) {
		throw new HelmRequestError(422, error instanceof Error ? error.message : String(error));
	}
}

/** A picked doc's `.feat` children, for a row of its tree to expand into. */
export function helmFeats(cwd: string, ref: string): HelmFeat[] | undefined {
	const view = bridgeView(cwd);
	const doc = pickedDoc(view, ref);
	return doc ? featItems(view, doc, new Map(view.docs.map((d) => [d.id, d]))) : undefined;
}

/**
 * The repos a picked doc scopes -- inherited the way a dive inherits them, the
 * backlog's when none is named -- by name: what a note can be about.
 */
export function helmRepoList(cwd: string, ref?: string): { id: string; name: string }[] {
	const view = bridgeView(cwd);
	const byId = new Map(view.docs.map((doc) => [doc.id, doc]));
	const wanted = ref ?? view.rc.backlog;
	const doc = wanted ? pickedDoc(view, wanted) : undefined;
	return (doc ? rootedScopes(view.rc, view.docs, doc).all : [])
		.map((scope) => byId.get(scope.repoId))
		.filter((repo): repo is KbDoc => repo?.kind === "repo")
		.map((repo) => ({ id: repo.id, name: repo.name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
