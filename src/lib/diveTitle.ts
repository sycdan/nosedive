import { uuidLike } from "./coreParsing.js";
import type { KbDoc } from "./kbDocs.js";
import { managedDiveName, titleFromSlug } from "./slugs.js";

export function diveFeatLabel(feat: KbDoc): string {
	return uuidLike(feat.name) ? (feat.h1 ?? feat.name) : feat.name;
}

/** The default heading for a planned or unplanned feat-owned dive. */
export function defaultDiveTitle(feat: KbDoc, id: string): string {
	return `${titleFromSlug(diveFeatLabel(feat).replaceAll(" ", "-"))} ${managedDiveName("", id).slice(1)}`;
}
