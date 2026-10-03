import { readNosediveRc, uuidLike, type NosediveRc } from "./coreParsing.js";
import { findDocs } from "./find.js";
import { helmRepoDoc } from "./helmLinks.js";
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

/**
 * The dives a root reaches that are still dives -- the selection `nosedive
 * find dive` makes from the backlog, made from the root (the backlog when none
 * is named), or from one feat under it, and narrowed by its term -- and the
 * active one.
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
	const activeId = readActiveDiveId(rc.workspaceDir);
	const active = activeId ? byId.get(activeId) : undefined;
	return {
		active: active ? card(active, byId, rc) : null,
		dives: reached.map((dive) => card(dive, byId, rc)),
	};
}
