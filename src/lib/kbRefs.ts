import { formatPath, scalarToString, uuidLike } from "./coreParsing.js";

export interface ScopeRef {
	repoId: string;
	path: string;
	ref?: string;
	/**
	 * The branch `land` publishes this scope's HEAD to. Naming one is the whole
	 * of what makes a scope landable: work with nowhere to go is work `land`
	 * must refuse, and a dive has to be explicit about where it will push.
	 */
	workBranch?: string;
	/**
	 * Not landable, which is exactly "names no work branch".
	 *
	 * Derived, never declared. `mode: ro`, `mode: rw` and `flags: [ro]` are all
	 * still accepted so documents written before this parse, but none of them
	 * decides anything: a scope carrying `mode: rw` and no branch is read-only,
	 * and `land` says so and names `--upscope` as the fix.
	 */
	readOnly: boolean;
	/**
	 * The superseded `mode`, kept only so a feat scope written before branches
	 * existed can still say "dives on me are meant to push here". A feat entry
	 * carrying `mode: rw` and no branch hands a generated one to the dives that
	 * inherit it; nothing else reads this.
	 */
	legacyMode?: "ro" | "rw";
	flags: string[];
	render?: "body" | "gist";
}

export interface LinkRef {
	id: string;
	target: string;
	rel?: string;
	anchor?: string;
	/** Every scalar key written on the link, `rel`/`anchor` included. Open set: the reading command validates what it needs. */
	attrs: Record<string, string>;
}

export function optionalScopeString(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!Object.hasOwn(value, key)) return undefined;
	const scalar = scalarToString(value[key]);
	if (scalar === undefined || scalar.trim() === "") {
		throw new Error(`invalid scope entry in ${label}: ${key} must be a non-empty string`);
	}
	return scalar;
}

export function optionalScopeFlags(value: Record<string, unknown>, label: string): string[] {
	if (!Object.hasOwn(value, "flags")) return [];
	const raw = value.flags;
	if (!Array.isArray(raw))
		throw new Error(`invalid scope entry in ${label}: flags must be a YAML list`);
	return raw.map((entry) => {
		const flag = scalarToString(entry);
		if (!flag || flag.trim() === "")
			throw new Error(`invalid scope entry in ${label}: flags must contain non-empty strings`);
		return flag;
	});
}

export function parseScopeRef(scope: unknown, path: string, index: number): ScopeRef {
	const label = `${formatPath(path)} scopes[${index}]`;
	if (typeof scope === "string") {
		const repoId = scope.trim();
		if (uuidLike(repoId)) {
			// A bare entry names a repo and nothing else, so it names no branch and
			// is not landable until something upscopes it.
			return { repoId, path: "", readOnly: true, flags: [] };
		}
		throw new Error(
			`legacy scope shorthand is not supported in ${label}; use a bare quid or '- <repo-id>: { ... }' object form`,
		);
	}
	if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
		throw new Error(`invalid scope entry in ${label}: expected a one-key object`);
	}

	const keys = Object.keys(scope as Record<string, unknown>);
	if (keys.length !== 1) {
		throw new Error(`invalid scope entry in ${label}: expected exactly one repo id key`);
	}

	const repoId = keys[0]!.trim();
	if (!repoId) throw new Error(`invalid scope entry in ${label}: repo id key must be non-empty`);

	const rawValue = (scope as Record<string, unknown>)[repoId];
	if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
		throw new Error(`invalid scope entry in ${label}: value for '${repoId}' must be a YAML object`);
	}

	const value = rawValue as Record<string, unknown>;
	const ref = optionalScopeString(value, "ref", label);
	const pathValue = optionalScopeString(value, "path", label) ?? "";
	const mode = optionalScopeString(value, "mode", label);
	const workBranch = optionalScopeString(value, "work-branch", label);
	const render = optionalScopeString(value, "render", label) as "body" | "gist" | undefined;
	const flags = optionalScopeFlags(value, label);

	if (render && render !== "body" && render !== "gist") {
		throw new Error(`invalid scope entry in ${label}: render must be 'body' or 'gist'`);
	}
	if (mode && mode !== "ro" && mode !== "rw") {
		throw new Error(`invalid scope entry in ${label}: mode must be 'ro' or 'rw'`);
	}
	if (flags.some((flag) => flag === "body" || flag === "gist")) {
		throw new Error(`invalid scope entry in ${label}: body/gist must use render, not flags`);
	}

	const flagReadOnly = flags.includes("ro");
	if (mode === "rw" && flagReadOnly) {
		throw new Error(`invalid scope entry in ${label}: mode=rw conflicts with flags containing ro`);
	}

	if (repoId === ".") {
		if (ref) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set ref`);
		if (pathValue) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set path`);
		if (mode) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set mode`);
		if (workBranch)
			throw new Error(`invalid scope entry in ${label}: '.' scope cannot set work-branch`);
	}

	return {
		repoId,
		path: pathValue,
		ref,
		workBranch,
		readOnly: !workBranch,
		legacyMode: mode === "rw" || flags.includes("rw") ? "rw" : mode === "ro" ? "ro" : undefined,
		flags,
		render,
	};
}

export function parseScopeRefs(value: unknown, path: string): ScopeRef[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value))
		throw new Error(`invalid scopes in ${formatPath(path)}: expected a YAML list`);
	return value.map((scope, index) => parseScopeRef(scope, path, index));
}

export function optionalLinkString(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!Object.hasOwn(value, key)) return undefined;
	const scalar = scalarToString(value[key]);
	if (scalar === undefined || scalar.trim() === "") {
		throw new Error(`invalid link entry in ${label}: ${key} must be a non-empty string`);
	}
	return scalar;
}

function linkDocId(target: string): string {
	const kbDocMatch =
		/^kb\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i.exec(target);
	if (kbDocMatch) return kbDocMatch[1]!.toLowerCase();
	return target;
}

export function parseLinkRef(link: unknown, path: string, index: number): LinkRef {
	const label = `${formatPath(path)} links[${index}]`;
	if (typeof link === "string") {
		const target = link.trim();
		if (!target) throw new Error(`invalid link entry in ${label}: target must be non-empty`);
		if (target.includes("#")) {
			const [targetPath, ...anchorParts] = target.split("#");
			const anchor = anchorParts.join("#");
			if (!targetPath || !anchor) {
				throw new Error(`invalid link entry in ${label}: target and anchor must be non-empty`);
			}
			return { id: linkDocId(targetPath), target: targetPath, anchor, attrs: { anchor } };
		}
		return { id: linkDocId(target), target, attrs: {} };
	}
	if (!link || typeof link !== "object" || Array.isArray(link)) {
		throw new Error(
			`invalid link entry in ${label}: expected a bare target string or a one-key object`,
		);
	}

	const keys = Object.keys(link as Record<string, unknown>);
	if (keys.length !== 1) {
		throw new Error(`invalid link entry in ${label}: expected exactly one target key`);
	}

	const target = keys[0]!.trim();
	if (!target) throw new Error(`invalid link entry in ${label}: target key must be non-empty`);

	const rawValue = (link as Record<string, unknown>)[keys[0]!];
	if (rawValue === null || rawValue === undefined)
		return { id: linkDocId(target), target, attrs: {} };
	if (typeof rawValue !== "object" || Array.isArray(rawValue)) {
		throw new Error(`invalid link entry in ${label}: value for '${target}' must be a YAML object`);
	}

	const value = rawValue as Record<string, unknown>;
	const rel = optionalLinkString(value, "rel", label);
	const anchor = optionalLinkString(value, "anchor", label);

	/**
	 * Every scalar key is carried through, not just the ones known here: link
	 * attributes are an open set, and a command that grows a new one should not
	 * need this parser edited. Interpreting an attribute -- and rejecting a
	 * malformed value -- belongs to whichever command reads it.
	 */
	const attrs: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		const scalar = scalarToString(raw);
		if (scalar === undefined) {
			throw new Error(`invalid link entry in ${label}: ${key} must be a scalar`);
		}
		attrs[key] = scalar;
	}
	return { id: linkDocId(target), target, rel, anchor, attrs };
}

export function parseLinkRefs(value: unknown, path: string): LinkRef[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value))
		throw new Error(`invalid links in ${formatPath(path)}: expected a YAML list`);
	return value.map((link, index) => parseLinkRef(link, path, index));
}
