/** A plain mapping: not null, not a list. */
function isMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON Merge Patch, RFC 7386 section 2, as written there: a mapping merges key
 * by key, recursively, a null removes its key, and anything else -- a scalar
 * or a list -- replaces what it patches whole.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
	if (!isMapping(patch)) return patch;
	const merged: Record<string, unknown> = isMapping(target) ? { ...target } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete merged[key];
		else merged[key] = mergePatch(merged[key], value);
	}
	return merged;
}

/**
 * A `scopes:` or `links:` list as a mapping keyed by each entry's target, so a
 * merge patch can address one entry by what it points at. A bare entry maps to
 * an empty mapping.
 */
export function entriesToMapping(entries: unknown, block: string): Record<string, unknown> {
	if (entries == null) return {};
	if (!Array.isArray(entries)) throw new Error(`${block} is not a list`);
	const mapping: Record<string, unknown> = {};
	for (const entry of entries) {
		if (typeof entry === "string") mapping[entry] = {};
		else if (isMapping(entry) && Object.keys(entry).length === 1) {
			const [key, value] = Object.entries(entry)[0]!;
			mapping[key] = value ?? {};
		} else
			throw new Error(
				`${block} has an entry that is neither a target nor one target: ${JSON.stringify(entry)}`,
			);
	}
	return mapping;
}

/** The mapping back as a list, in key order; an entry with nothing under it is written bare. */
export function mappingToEntries(mapping: unknown, block: string): unknown[] {
	if (!isMapping(mapping)) throw new Error(`${block} must be a mapping of targets`);
	return Object.entries(mapping).map(([key, value]) =>
		value == null || (isMapping(value) && Object.keys(value).length === 0) ? key : { [key]: value },
	);
}

export { isMapping };
