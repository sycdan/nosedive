import type { NosediveRc } from "./coreParsing.js";
import { inheritedScopes, isParentRel } from "./diveScopes.js";
import type { KbDoc, ScopeRef } from "./kbDocs.js";
import { linkedDoc } from "./repoLinks.js";

/** A doc's identity across repos: the same id may sit in two kbs. */
export const docKey = (doc: KbDoc): string => `${doc.home?.repoId ?? ""}:${doc.id}`;

/** The backlog memo `backlog:` names: where the walk for feats starts. */
function backlogRoot(rc: NosediveRc, kbDocs: KbDoc[]): KbDoc {
	if (!rc.backlog)
		throw new Error("jump needs a configured backlog memo, the root a feat is reached from");
	const root = kbDocs.find((doc) => doc.id === rc.backlog);
	if (!root) throw new Error(`bridge backlog memo not found: ${rc.backlog}`);
	return root;
}

/** A link down the feat tree: its rel ends in `.feat`, and it does not point back up at a parent. */
export const isFeatEdge = (rel: string | undefined): boolean =>
	Boolean(rel?.endsWith(".feat")) && !isParentRel(rel);

const anyFeatRel = (rel: string | undefined): boolean => Boolean(rel?.endsWith(".feat"));

/**
 * The docs `from`'s links reach in one step, each once, in link order: down
 * the feat tree, or, for jump, through any `.feat` rel at all.
 */
export function featChildren(
	rc: NosediveRc,
	from: KbDoc,
	byId: Map<string, KbDoc>,
	edge = isFeatEdge,
): KbDoc[] {
	const children = new Map<string, KbDoc>();
	for (const link of from.links) {
		if (!edge(link.rel)) continue;
		const target = linkedDoc(rc, from, link, byId);
		if (target && !children.has(docKey(target))) children.set(docKey(target), target);
	}
	return [...children.values()];
}

/** Every doc `featChildren` reaches from `start`, by key, with the key of the doc it was first reached from. */
function featWalk(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	start: KbDoc,
	edge: (rel: string | undefined) => boolean,
): Map<string, { doc: KbDoc; via: string }> {
	const byId = new Map(kbDocs.map((candidate) => [candidate.id, candidate]));
	const queue = [start];
	const walked = new Set<string>();
	const reached = new Map<string, { doc: KbDoc; via: string }>();
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (walked.has(docKey(current))) continue;
		walked.add(docKey(current));
		for (const target of featChildren(rc, current, byId, edge)) {
			if (!reached.has(docKey(target)))
				reached.set(docKey(target), { doc: target, via: docKey(current) });
			queue.push(target);
		}
	}
	return reached;
}

/** The keys of every doc `featChildren` reaches from `start`, at any depth. */
export function featReach(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	start: KbDoc,
	edge = isFeatEdge,
): Set<string> {
	return new Set(featWalk(rc, kbDocs, start, edge).keys());
}

/**
 * The docs a walk from the backlog passes through to reach `feat` by `.feat`
 * links, nearest first and the backlog last; none when it does not reach it.
 */
function featAncestors(rc: NosediveRc, kbDocs: KbDoc[], feat: KbDoc): KbDoc[] {
	const backlog = rc.backlog ? kbDocs.find((doc) => doc.id === rc.backlog) : undefined;
	if (!backlog) return [];
	const reached = featWalk(rc, kbDocs, backlog, anyFeatRel);
	let step = reached.get(docKey(feat));
	if (!step) return [];
	const chain: KbDoc[] = [];
	while (step.via !== docKey(backlog)) {
		step = reached.get(step.via)!;
		chain.push(step.doc);
	}
	return [...chain, backlog];
}

/**
 * The scope a dive takes for the repo its feat lives in, when that is not the
 * bridge: the entry of the nearest doc on the feat's `.feat` path, outside
 * that repo, that names a branch for it -- the doc whose link crosses into the
 * repo, which is the branch the feat was read at. A doc inside the repo scoping
 * it, a sub-bridge's backlog scoping itself, speaks for that bridge's own dives.
 * Undefined `workBranch` when none does; the dive then takes the feat's default.
 * @see kb/01a11c86-8bb4-7a3a-a33b-58a25a51b990.md
 */
function featRepoScope(rc: NosediveRc, kbDocs: KbDoc[], feat: KbDoc): ScopeRef | undefined {
	const repoId = feat.home?.repoId;
	if (!repoId) return undefined;
	const named = featAncestors(rc, kbDocs, feat)
		.filter((doc) => doc.home?.repoId !== repoId)
		.map((doc) => doc.scopes.find((scope) => scope.repoId === repoId && scope.workBranch))
		.find((scope) => scope !== undefined);
	return named ?? { repoId, path: "", readOnly: false, flags: [], attrs: {} };
}

/**
 * Whether `doc` can be jumped into as a feat: some link whose rel ends in
 * `.feat` reaches it on a walk from the backlog memo, across repos the way the
 * dive walk crosses them. Its kind does not enter into it, and the backlog
 * itself is where the walk starts, not something it reaches.
 */
export function isJumpable(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	doc: KbDoc,
	repoId = doc.home?.repoId,
): boolean {
	return featReach(rc, kbDocs, backlogRoot(rc, kbDocs), anyFeatRel).has(
		`${repoId ?? ""}:${doc.id}`,
	);
}

/**
 * The scopes a dive under `feat` starts from: its nearest scoped ancestor's,
 * plus the backlog's when the backlog reaches it through `.feat` links. `all`
 * names each repo once, the ancestor's entry winning; `root` is the backlog's
 * whole list, which `--clear-scopes` keeps. `home` is the repo a feat in
 * another repo lives in, when neither names it: see `featRepoScope`.
 */
export function rootedScopes(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	feat: KbDoc,
): { nearest: ScopeRef[]; root: ScopeRef[]; home?: ScopeRef; backlog?: KbDoc; all: ScopeRef[] } {
	const nearest = inheritedScopes(feat, kbDocs).scopes;
	const backlog = rc.backlog ? kbDocs.find((doc) => doc.id === rc.backlog) : undefined;
	const reached =
		backlog && (backlog === feat || featReach(rc, kbDocs, backlog, anyFeatRel).has(docKey(feat)));
	const root = reached ? backlog.scopes : [];
	const named = new Set(nearest.map((scope) => scope.repoId));
	const all = [...nearest, ...root.filter((scope) => !named.has(scope.repoId))];
	const home = all.some((scope) => scope.repoId === feat.home?.repoId)
		? undefined
		: featRepoScope(rc, kbDocs, feat);
	return { nearest, root, home, backlog, all: home ? [...all, home] : all };
}

export function assertJumpable(rc: NosediveRc, kbDocs: KbDoc[], doc: KbDoc): void {
	if (!doc.home && doc.id === rc.backlog)
		throw new Error(`${doc.name} is the backlog, not a feat; jump one of its feats`);
	if (isJumpable(rc, kbDocs, doc)) return;
	throw new Error(
		`${doc.name} is not a feat: nothing reaches it from the root through a .feat link; link it from a feat first`,
	);
}
