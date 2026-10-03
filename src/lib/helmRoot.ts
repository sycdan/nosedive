import { basename } from "node:path";

import type { HelmLink, HelmRoot } from "./helm.js";
import { helmBranchStatus, type HelmBranchStatus } from "./helmBranch.js";
import { readActiveDiveId, type KbDoc } from "./kbDocs.js";
import { helmLink } from "./helmLinks.js";
import { bridgeView, viewRoots } from "./helmView.js";
import { diveRoot } from "./roots.js";
import { KB_FEAT_ID } from "./shipZerostars.js";

const FEAT_ROLE = /(^|\.)(feat|effort)$/;

/**
 * The root helm has picked and what hangs off it: the bridge, its backlog
 * memo and the other roots, for the picker; the picked root and the feats it
 * links (the kb feat first). With no dive the pilot picks, the backlog by
 * default; on one the root is the dive's `meta.root`, or the backlog when it
 * names none, and cannot be changed. All read through the view, so a dive
 * that scopes the bridge shows what it has written.
 */
export function helmRoots(
	cwd: string,
	asked?: string,
): {
	bridge: { id?: string; name: string; branch: HelmBranchStatus };
	backlog?: HelmRoot;
	roots: HelmRoot[];
	root?: string;
	locked: boolean;
	feats: HelmLink[];
	diving: boolean;
} {
	const view = bridgeView(cwd);
	const { rc, docs } = view;
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const bridgeDoc = rc.bridge ? byId.get(rc.bridge) : undefined;
	const card = (id: string): HelmRoot => {
		const doc = byId.get(id);
		if (!doc) return { id, name: id, kind: "missing", gist: `no kb doc ${id}` };
		return { id, name: doc.name, kind: doc.kind, gist: doc.gist, title: doc.h1 };
	};
	const roots = viewRoots(view).filter((id) => id !== rc.backlog);
	const pickable = new Set([rc.backlog, ...roots].filter(Boolean));
	const activeId = readActiveDiveId(rc.workspaceDir);
	const activeDive = activeId ? byId.get(activeId) : undefined;
	const wanted = activeId ? (activeDive ? diveRoot(activeDive) : undefined) : asked;
	const rootId = wanted && pickable.has(wanted) ? wanted : rc.backlog;
	const root = rootId ? byId.get(rootId) : undefined;
	// A feat in another repo is listed too, unresolved when it cannot be read.
	const isKbFeat = (link: HelmLink) => link.type === "doc" && link.id === KB_FEAT_ID;
	const feats = root
		? root.links
				.filter((link) => FEAT_ROLE.test(link.rel ?? ""))
				.map((link) => helmLink(view, root, rc.bridge, byId, link))
				.filter((link) => link.type === "doc" || link.type === "unresolved")
				.sort((a, b) => Number(isKbFeat(b)) - Number(isKbFeat(a)))
		: [];
	return {
		bridge: {
			id: rc.bridge,
			name: bridgeDoc?.name ?? basename(rc.bridgeDir),
			branch: helmBranchStatus(rc.bridgeDir, bridgeDoc?.repoBaseBranch ?? "main"),
		},
		backlog: rc.backlog ? card(rc.backlog) : undefined,
		roots: roots.map(card),
		root: rootId,
		locked: Boolean(activeId),
		feats,
		diving: Boolean(activeId),
	};
}

/** The repos a root scopes -- the backlog when none is named -- by name: what a note can be about. */
export function helmRepoList(cwd: string, rootId?: string): { id: string; name: string }[] {
	const { rc, docs } = bridgeView(cwd);
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const wanted = rootId ?? rc.backlog;
	const root = wanted ? byId.get(wanted) : undefined;
	return (root?.scopes ?? [])
		.map((scope) => byId.get(scope.repoId))
		.filter((doc): doc is KbDoc => doc?.kind === "repo")
		.map((doc) => ({ id: doc.id, name: doc.name }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
