import { uuidLike } from "./coreParsing.js";
import type { KbDoc } from "./kbDocs.js";

/**
 * The doc ids a `roots:` value lists -- a comma string or a YAML list -- as
 * written, without the backlog.
 */
export function listedRoots(raw: unknown, key = "roots"): string[] {
	const entries =
		raw === undefined || raw === null || raw === ""
			? []
			: (Array.isArray(raw) ? raw.map(String) : String(raw).split(",")).map((entry) =>
					entry.trim().toLowerCase(),
				);
	for (const entry of entries) {
		if (!uuidLike(entry))
			throw new Error(`${key} lists doc ids, and ${JSON.stringify(entry)} is not one`);
	}
	return entries;
}

/**
 * The bridge's roots: the backlog memo first, then the config's `roots:`. The
 * backlog is always a root and is never written into the config; listed
 * there anyway, it appears once, where it is listed.
 */
export function parseRoots(raw: unknown, backlog: string | undefined): string[] {
	const listed = listedRoots(raw);
	const roots = backlog && !listed.includes(backlog) ? [backlog, ...listed] : listed;
	return [...new Set(roots)];
}

/** The root a dive was planned or jumped from: `meta.root`, or the older `meta.deck`. */
export function diveRoot(doc: KbDoc): string | undefined {
	return doc.metaScalars.root ?? doc.metaScalars.deck;
}
