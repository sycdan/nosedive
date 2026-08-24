import { uuidLike } from "./coreParsing.js";
import { resolveBridgeDocRef } from "./diveScopes.js";
import type { KbDoc } from "./kbDocs.js";

/**
 * Whether a `record.*` positional names a document on this bridge.
 *
 * Asked of the bridge rather than of the string's shape, because shape cannot
 * separate the two things a positional can be: a clone URL and a kb path both
 * carry slashes, and `record.repo` has to tell them apart. A quid counts as a
 * ref whether or not it resolves -- nobody types one by accident, so a missing
 * one is a typo the resolver should name, not a gist to record.
 */
export function bridgeDocRefPredicate(
	bridgeDir: string,
	kbDocs: KbDoc[],
): (arg: string) => boolean {
	return (arg) => {
		if (uuidLike(arg)) return true;
		try {
			resolveBridgeDocRef(bridgeDir, kbDocs, arg);
			return true;
		} catch {
			return false;
		}
	};
}

/**
 * `record.* "<gist>"` was the old spelling and still works at this level, so a
 * walkthrough written against it does not break under a bridge that upgraded.
 * Level 3 drops the fallback: by then the positional means the document, and a
 * positional read two ways is how a rename gets recorded as a new feat.
 */
export function positionalGistNotice(command: string, flag = "--gist"): string {
	return (
		`${command}: the positional argument is deprecated -- pass ${flag} instead. ` +
		"The positional now names the document to edit."
	);
}
