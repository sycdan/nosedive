import { readActiveDiveId } from "./kbDocs.js";
import { DIVE_KIND_ID, isBridge, isShipped, kindSources, loadKinds } from "./kinds.js";
import { readNosediveRc } from "./coreParsing.js";

export interface HelmCreatableKind {
	id: string;
	name: string;
	gist: string;
	repoId?: string;
	repoName: string;
	schema?: unknown;
	/** A kind nosedive ships, offered to a repo that does not define its own. */
	shipped?: boolean;
}

/**
 * What the dive bar can make: under each repo the active dive scopes, the
 * kinds `crud <repo>:<kind>` takes there -- its own and, outside a bridge, the
 * shipped ones it does not define -- by repo then name, with the schema for
 * the form. None with no dive, since helm writes only on one. Dives are left
 * out: one is planned on its feat, where the feat is known.
 */
export function helmCreatableKinds(cwd: string): HelmCreatableKind[] {
	const rc = readNosediveRc(cwd);
	if (!readActiveDiveId(rc.workspaceDir)) return [];
	const sources = kindSources(cwd);
	const kinds = loadKinds(sources);
	// The first of a name, as `repoKind` takes it.
	const shipped = kinds
		.filter(isShipped)
		.filter((kind, at, all) => all.findIndex((other) => other.name === kind.name) === at);
	return sources
		.flatMap((source) => {
			const own = kinds
				.filter((kind) => kind.source.root === source.root && kind.id !== DIVE_KIND_ID)
				.map((kind) => ({ kind, shipped: false }));
			const taken = isBridge(source)
				? []
				: shipped
						.filter((kind) => !own.some((entry) => entry.kind.name === kind.name))
						.map((kind) => ({ kind: { ...kind, source }, shipped: true }));
			return [...own, ...taken];
		})
		.map(({ kind, shipped }) => ({
			id: kind.id,
			name: kind.name,
			gist: kind.gist,
			repoId: kind.source.id,
			repoName: kind.source.name,
			schema: kind.meta.schema,
			...(shipped ? { shipped } : {}),
		}))
		.sort((a, b) => a.repoName.localeCompare(b.repoName) || a.name.localeCompare(b.name));
}
