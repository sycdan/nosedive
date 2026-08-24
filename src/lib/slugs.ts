export function pascalFromSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join("");
}

export function titleFromSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
}

export function assertSlug(slug: string, label: string): string {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new Error(`${label} must be kebab-case: ${slug}`);
	}
	return slug;
}

/**
 * A slug derived from a free-text gist, for a name minted with no `--name`: a
 * pilot's first pitch or gate is announced by what it checks rather than by a
 * clock. Truncated at a word boundary so the result reads as an identifier
 * rather than a clipped sentence, and undefined when the gist yields nothing
 * usable (all punctuation, all stopword-length noise, or empty) -- callers
 * fall back to a timestamp name rather than failing to mint at all.
 */
export function slugFromGist(gist: string, maxLen = 40): string | undefined {
	const words = gist
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	if (words.length === 0) return undefined;

	const picked: string[] = [];
	let length = 0;
	for (const word of words) {
		const nextLength = length === 0 ? word.length : length + 1 + word.length;
		if (nextLength > maxLen) break;
		picked.push(word);
		length = nextLength;
	}
	// Nothing fit within maxLen (e.g. a single very long word): fall back to
	// nothing usable rather than emitting a slug the caller did not ask for.
	if (picked.length === 0) return undefined;
	return picked.join("-");
}

/**
 * A dive's name is managed: it is its feat's name plus enough of its own id to
 * tell two dives on one feat apart. Shared because renaming a feat has to
 * recompute every dive on it, and a second spelling of this rule would leave
 * half the dives named after a feat that no longer exists.
 */
export function managedDiveName(featName: string, diveId: string): string {
	return `${featName}.${diveId.replaceAll("-", "").slice(-6)}`;
}
