import { readNosediveRc, uuidLike, type NosediveRc } from "./coreParsing.js";
import { sameFeatRef } from "./diveListing.js";
import { findDocs, matchesTerm } from "./find.js";
import { helmRepoDoc } from "./helmLinks.js";
import { docKey, featChildren } from "./jumpable.js";
import { loadKbDocs, readActiveDiveId, type KbDoc } from "./kbDocs.js";

export interface HelmDiveCard {
	id: string;
	title: string;
	gist: string;
	feat?: string;
	repos: string[];
	diver?: string;
}

function card(dive: KbDoc, byId: Map<string, KbDoc>, rc: NosediveRc): HelmDiveCard {
	// A feat in another repo is named `<repo-quid>:<path>`.
	const ref = dive.featRef;
	const feat = ref
		? (byId.get(ref) ?? helmRepoDoc({ rc, docs: [...byId.values()] }, ref))
		: undefined;
	return {
		id: dive.id,
		title: dive.h1 ?? dive.name,
		gist: dive.gist,
		// A feat named by its own id is known by its heading.
		feat: feat && uuidLike(feat.name) ? (feat.h1 ?? feat.name) : feat?.name,
		repos: dive.scopes.map((scope) => byId.get(scope.repoId)?.name ?? scope.repoId),
		diver: dive.metaScalars.diver || undefined,
	};
}

/** `start` and every feat below it through `.feat` links, read without a fetch. */
function featsBelow(rc: NosediveRc, start: KbDoc, byId: Map<string, KbDoc>): KbDoc[] {
	const found = new Map([[docKey(start), start]]);
	const queue = [start];
	while (queue.length)
		for (const child of featChildren(rc, queue.shift()!, byId))
			if (!found.has(docKey(child))) {
				found.set(docKey(child), child);
				queue.push(child);
			}
	return [...found.values()];
}

/**
 * The dives on deck -- those of the root (the backlog when none is named) or
 * of one feat, and of every feat below it -- narrowed by its term, and the
 * active one. A dive is on a feat when the feat links it, the selection
 * `nosedive find dive` makes, or when its `feat` names it, which is how a
 * feat in another repo has its dives.
 */
export function helmDives(
	cwd: string,
	term?: string,
	root?: string,
	feat?: string,
): { active: HelmDiveCard | null; dives: HelmDiveCard[] } {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("helm requires a configured kb directory");
	const docs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const startId = feat ?? root ?? rc.backlog;
	const start = startId ? (byId.get(startId) ?? helmRepoDoc({ rc, docs }, startId)) : undefined;
	const reached = start
		? findDocs(start, docs, "dive", term || undefined, rc.bridgeDir, {
				scopeIds: new Set(),
				kinds: ["dive"],
			})
		: [];
	if (start) {
		const listed = new Set(reached.map((dive) => dive.id));
		const feats = featsBelow(rc, start, byId);
		for (const dive of docs)
			if (
				dive.kind === "dive" &&
				!listed.has(dive.id) &&
				matchesTerm(dive, term) &&
				feats.some((feat) => sameFeatRef(dive.featRef, feat))
			)
				reached.push(dive);
	}
	const activeId = readActiveDiveId(rc.workspaceDir);
	const active = activeId ? byId.get(activeId) : undefined;
	return {
		active: active ? card(active, byId, rc) : null,
		dives: reached.map((dive) => card(dive, byId, rc)),
	};
}
