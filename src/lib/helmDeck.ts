import { builtinDocPath } from "./builtinKinds.js";
import { toPosixPath, uuidLike } from "./coreParsing.js";
import type { BridgeView } from "./helmView.js";
import { isFeatEdge } from "./jumpable.js";
import { readKbDoc, type KbDoc, type LinkRef } from "./kbDocs.js";
import { splitRepoRef } from "./kbRefs.js";
import { mayLinkRepo, repoCheckout } from "./repoLinks.js";
import { readRepoRefDoc, repoBacklogId } from "./repoRead.js";

/**
 * A row of the deck picker: a doc reached from the bridge's backlog through
 * `.feat` links. `chain` is the refs that lead to it, the backlog's own link
 * first; `path` names the docs it was reached through.
 * @see kb/01a11be7-0691-7e74-9f93-afac333f04f3.md
 */
export interface DeckRow {
	/** Its id in the bridge, `<repo-quid>:<path>` in another repo. */
	ref: string;
	id: string;
	repo?: string;
	repoName?: string;
	chain: string[];
	path: string[];
	name: string;
	title?: string;
	gist: string;
	/** A backlog: listed, never the deck. */
	container?: true;
	/** In a repo nobody hydrated, not read yet: Load reads it. */
	load?: true;
}

/** One walk's reads: which repos can be read without a fetch, and what their configs name. */
interface Walk {
	view: BridgeView;
	byId: Map<string, KbDoc>;
	/** Repos read through their managed cache in this request, so fresh. */
	fresh: Set<string>;
	readable: Map<string, boolean>;
	backlogs: Map<string, string | undefined>;
}

type Reached = { doc: KbDoc } | { ref: string; repo: KbDoc };

export const deckRef = (doc: KbDoc): string =>
	doc.home ? `${doc.home.repoId}:${doc.relPath}` : doc.id;

function newWalk(view: BridgeView): Walk {
	const byId = new Map(view.docs.map((doc) => [doc.id, doc]));
	return { view, byId, fresh: new Set(), readable: new Map(), backlogs: new Map() };
}

/** Hydrated, or read fresh in this request: either is read without a fetch. */
function readable(walk: Walk, repo: KbDoc): boolean {
	if (walk.fresh.has(repo.id)) return true;
	if (!walk.readable.has(repo.id))
		walk.readable.set(repo.id, Boolean(repoCheckout(walk.view.rc, repo)));
	return walk.readable.get(repo.id)!;
}

function isContainer(walk: Walk, doc: KbDoc): boolean {
	const { rc } = walk.view;
	if (!doc.home) return doc.id === rc.backlog;
	const repoId = doc.home.repoId;
	if (!walk.backlogs.has(repoId)) {
		const repo = walk.byId.get(repoId);
		walk.backlogs.set(repoId, repo && repoBacklogId(rc, repo, doc.scopes));
	}
	return walk.backlogs.get(repoId) === doc.id;
}

/** A sub-bridge's backlog goes by its repo's name; a doc named by its id, by its heading. */
function shownName(walk: Walk, doc: KbDoc, container: boolean): string {
	if (container && doc.home) return walk.byId.get(doc.home.repoId)?.name ?? doc.name;
	return uuidLike(doc.name) ? (doc.h1 ?? doc.gist) : doc.name;
}

/**
 * What a `.feat` link reaches, the way `linkedDoc` resolves it. A doc in a
 * repo that cannot be read without a fetch is reached unread, unless `fetch`
 * allows the read; then a failure throws its one-line reason.
 */
function reach(walk: Walk, from: KbDoc, link: LinkRef, fetch: boolean): Reached | undefined {
	const { rc } = walk.view;
	const builtin = builtinDocPath(link.id);
	if (builtin) return { doc: readKbDoc(builtin, rc.bridgeDir) };
	const inBridge = () => {
		const doc = walk.byId.get(link.id);
		return doc ? { doc } : undefined;
	};
	const fromRepo = from.home?.repoId ?? rc.bridge;
	const repoId = link.repo ?? fromRepo;
	if (!repoId || repoId === rc.bridge) return inBridge();
	if (link.repo && !mayLinkRepo(rc, from.scopes, fromRepo, repoId)) return undefined;
	const repo = walk.byId.get(repoId);
	if (repo?.kind !== "repo") return link.repo ? undefined : inBridge();
	const path = toPosixPath(link.repo ? splitRepoRef(link.target)!.path : `kb/${link.id}.md`);
	if (!fetch && !readable(walk, repo)) return { ref: `${repoId}:${path}`, repo };
	try {
		const doc = readRepoRefDoc(rc, repo, path, from.scopes);
		if (doc) {
			walk.fresh.add(repoId);
			return { doc };
		}
	} catch (error) {
		if (fetch && link.repo) throw error;
	}
	return link.repo ? undefined : inBridge();
}

const refOfReached = (found: Reached) => ("doc" in found ? deckRef(found.doc) : found.ref);

function rowOf(walk: Walk, found: Reached, chain: string[], path: string[]): DeckRow {
	const ref = refOfReached(found);
	if (!("doc" in found)) {
		const name = found.repo.name;
		return {
			ref,
			id: ref,
			repo: found.repo.id,
			repoName: name,
			chain,
			path,
			name,
			gist: ref,
			load: true,
		};
	}
	const { doc } = found;
	const container = isContainer(walk, doc);
	const name = shownName(walk, doc, container);
	const repo = doc.home?.repoId;
	return {
		ref,
		id: doc.id,
		...(repo ? { repo, repoName: walk.byId.get(repo)?.name ?? repo } : {}),
		chain,
		path,
		name,
		...(doc.h1 && doc.h1 !== name ? { title: doc.h1 } : {}),
		gist: doc.gist,
		...(container ? { container: true as const } : {}),
	};
}

/** The rows below `start`, each once, nearest first; `seen` holds refs already listed. */
function rowsBelow(walk: Walk, start: KbDoc, chain: string[], path: string[], seen: Set<string>) {
	const rows: DeckRow[] = [];
	const queue = [{ doc: start, chain, path }];
	while (queue.length) {
		const { doc, chain, path } = queue.shift()!;
		for (const link of doc.links) {
			if (!isFeatEdge(link.rel)) continue;
			const found = reach(walk, doc, link, false);
			if (!found || seen.has(refOfReached(found))) continue;
			const row = rowOf(walk, found, [...chain, refOfReached(found)], path);
			seen.add(row.ref);
			rows.push(row);
			if ("doc" in found)
				queue.push({ doc: found.doc, chain: row.chain, path: [...path, row.name] });
		}
	}
	return rows;
}

/** Path by path, so a doc's rows sit right under it; then by name. */
export function deckOrder(a: DeckRow, b: DeckRow): number {
	const left = [...a.path, a.name];
	const right = [...b.path, b.name];
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const order = left[i]!.localeCompare(right[i]!);
		if (order) return order;
	}
	return left.length - right.length;
}

/**
 * Every row the bridge's backlog reaches without a fetch, sorted, with the
 * default deck: the first feat the backlog links.
 */
export function deckRows(view: BridgeView): {
	backlog?: DeckRow;
	rows: DeckRow[];
	defaultChain?: string[];
} {
	const walk = newWalk(view);
	const start = view.rc.backlog ? walk.byId.get(view.rc.backlog) : undefined;
	if (!start) return { rows: [] };
	const backlog = { ...rowOf(walk, { doc: start }, [], []), container: true as const };
	const rows = rowsBelow(walk, start, [], [], new Set([backlog.ref]));
	const first = rows.find((row) => row.chain.length === 1 && !row.container && !row.load);
	return { backlog, rows: rows.sort(deckOrder), defaultChain: first?.chain };
}

/**
 * Load: reads the docs `chain` names, step by step from the backlog -- each
 * through `crud`'s read, fetching a stale cache -- and lists the last one's
 * row and the rows below it. Throws the first step that cannot be read.
 */
export function deckLoad(view: BridgeView, chain: string[]): DeckRow[] {
	const walk = newWalk(view);
	let doc = view.rc.backlog ? walk.byId.get(view.rc.backlog) : undefined;
	if (!doc || !chain.length) throw new Error("load needs a chain of refs from the backlog");
	let row: DeckRow | undefined;
	let path: string[] = [];
	for (const [index, ref] of chain.entries()) {
		const from: KbDoc = doc;
		const link = from.links.find((candidate) => {
			if (!isFeatEdge(candidate.rel)) return false;
			const found = reach(walk, from, candidate, false);
			return found !== undefined && refOfReached(found) === ref;
		});
		const found = link && reach(walk, from, link, true);
		if (!found || !("doc" in found)) throw new Error(`cannot read ${ref} from ${from.name}`);
		if (row) path = [...path, row.name];
		row = rowOf(walk, found, chain.slice(0, index + 1), path);
		doc = found.doc;
	}
	const below = rowsBelow(walk, doc, chain, [...path, row!.name], new Set(chain));
	return [row!, ...below.sort(deckOrder)];
}
