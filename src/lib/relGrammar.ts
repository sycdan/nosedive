/**
 * The rel grammar, and nothing else. Depends on nothing so that both the
 * backlog renderer and the gate walk can read it without importing each other.
 */

export interface RelParts {
	predicate: string;
	role?: string;
}

/** Roles the legacy dash spelling may carry. `effort` is the old word for `feat`. */
const DASH_ROLES = new Set(["feat", "effort"]);

/**
 * `<predicate>.<role>`, plus the legacy `<predicate>-effort` spelling that
 * predates the grammar. A rel with no recognisable role is all predicate.
 */
export function relParts(rel: string | undefined): RelParts | undefined {
	if (!rel) return undefined;
	const dot = rel.indexOf(".");
	if (dot > 0) return { predicate: rel.slice(0, dot), role: rel.slice(dot + 1) };
	const dash = rel.lastIndexOf("-");
	if (dash > 0 && DASH_ROLES.has(rel.slice(dash + 1))) {
		return { predicate: rel.slice(0, dash), role: rel.slice(dash + 1) };
	}
	return { predicate: rel };
}

/**
 * An edge a gate walk may follow: one whose rel names a feat, whatever its
 * predicate. Gates hang off feats and off repos, and repos are seeded as roots,
 * so feat to feat is the only traversal a gate walk needs.
 *
 * This is an allowlist, and that is the whole point. The walk used to follow
 * every link and name the edges to exclude, which made each new rel spelling a
 * new hole: a closed dive is `kind: memo`, so a bare `pending` edge to one was
 * invisible to a check for `.dive` or for `kind: dive`, and a land ran another
 * feat's gate through exactly that pair. Nothing has to be enumerated here for
 * that to stop -- `pending`, `working`, `landed.dive`, `landed-dive`, `patch`,
 * `related` and every spelling not yet invented are excluded by not being on
 * the list.
 *
 * Deliberately narrower than what the backlog renderer accepts. That has to
 * read bridges written before the grammar, so it still takes bare `child` and
 * `<predicate>-effort`; a gate walk is new surface and says `.feat` or is not
 * followed.
 */
export function isFeatEdge(rel: string | undefined): boolean {
	return relParts(rel)?.role === "feat";
}
