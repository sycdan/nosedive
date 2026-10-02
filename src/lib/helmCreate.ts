import { readActiveDiveId } from "./kbDocs.js";
import { bridgeHomed, DIVE_KIND_ID, kindSources, loadKinds } from "./kinds.js";
import { readNosediveRc } from "./coreParsing.js";

export interface HelmCreatableKind {
	id: string;
	name: string;
	gist: string;
	repoId?: string;
	repoName: string;
	schema?: unknown;
}

/**
 * What the dive bar can make: every kind in the repos the active dive scopes,
 * by repo then name, with its schema for the form. None with no dive, since
 * helm writes only on one. The dive kind counts only from a bridge, and
 * dives are left out: one is planned on its feat, where the feat is known.
 */
export function helmCreatableKinds(cwd: string): HelmCreatableKind[] {
	const rc = readNosediveRc(cwd);
	if (!readActiveDiveId(rc.workspaceDir)) return [];
	return bridgeHomed(loadKinds(kindSources(cwd)))
		.filter((kind) => kind.id !== DIVE_KIND_ID)
		.map((kind) => ({
			id: kind.id,
			name: kind.name,
			gist: kind.gist,
			repoId: kind.source.id,
			repoName: kind.source.name,
			schema: kind.meta.schema,
		}))
		.sort((a, b) => a.repoName.localeCompare(b.repoName) || a.name.localeCompare(b.name));
}
