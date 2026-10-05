import { basename } from "node:path";

import { sameFeatRef } from "./diveListing.js";
import { helmBranchStatus, type HelmBranchStatus } from "./helmBranch.js";
import { helmRepoDoc, type HelmLink } from "./helmLinks.js";
import { bridgeView, type BridgeView } from "./helmView.js";
import { docKey, featChildren, featReach, isFeatEdge, rootedScopes } from "./jumpable.js";
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

/** The docs `level` steps of `.feat` links below the backlog reach, each once. */
function levelDocs(view: BridgeView, backlog: KbDoc, byId: Map<string, KbDoc>, level: number) {
	let docs = [backlog];
	for (let depth = 0; depth < level; depth++) {
		const next = new Map<string, KbDoc>();
		for (const doc of docs)
			for (const child of featChildren(view.rc, doc, byId)) next.set(docKey(child), child);
		docs = [...next.values()];
	}
	return docs;
}

/** The first of `choices` that is the dive's feat or reaches it through `.feat` links. */
function diveAncestor(view: BridgeView, choices: KbDoc[], dive: KbDoc): KbDoc | undefined {
	const ref = dive.featRef;
	const feat = ref
		? (view.docs.find((doc) => sameFeatRef(ref, doc)) ?? helmRepoDoc(view, ref))
		: undefined;
	if (!feat) return undefined;
	const key = docKey(feat);
	return choices.find((doc) => docKey(doc) === key || featReach(view.rc, view.docs, doc).has(key));
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
 * What helm's picker offers and what the tree shows. Level 1 offers the
 * backlog's `.feat` children; level 2 offers theirs. The first is picked by
 * default. On a dive the pick locks to the offered ancestor of its feat, or
 * the first choice if none reaches it.
 */
export function helmPicker(
	cwd: string,
	asked?: string,
): {
	bridge: { id?: string; name: string; branch: HelmBranchStatus };
	level: number;
	backlog?: HelmPick;
	choices: HelmPick[];
	pick?: string;
	locked: boolean;
	feats: HelmFeat[];
} {
	const view = bridgeView(cwd);
	const { rc, docs } = view;
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const bridgeDoc = rc.bridge ? byId.get(rc.bridge) : undefined;
	const backlog = rc.backlog ? byId.get(rc.backlog) : undefined;
	const offered = backlog ? levelDocs(view, backlog, byId, rc.pickerLevel) : [];
	const activeId = readActiveDiveId(rc.workspaceDir);
	const dive = activeId ? byId.get(activeId) : undefined;
	const picked =
		(activeId
			? dive && diveAncestor(view, offered, dive)
			: offered.find((doc) => refOf(doc) === asked)) ?? offered[0];
	const missing = rc.backlog
		? {
				ref: rc.backlog,
				id: rc.backlog,
				name: rc.backlog,
				kind: "missing",
				gist: `no kb doc ${rc.backlog}`,
			}
		: undefined;
	return {
		bridge: {
			id: rc.bridge,
			name: bridgeDoc?.name ?? basename(rc.bridgeDir),
			branch: helmBranchStatus(rc.bridgeDir, bridgeDoc?.repoBaseBranch ?? "main"),
		},
		level: rc.pickerLevel,
		backlog: backlog ? pickOf(backlog) : missing,
		choices: offered.map(pickOf),
		pick: picked ? refOf(picked) : undefined,
		locked: Boolean(activeId),
		feats: picked ? featItems(view, picked, byId) : [],
	};
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
