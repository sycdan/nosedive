import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./renderPlan.js";

/**
 * A date, optionally a time, optionally a zone. Commands write the full
 * `toISOString` form; hands write the date alone; anything writing a UTC offset
 * rather than `Z` is read too.
 *
 * Deliberately a locator and not a validator. The problem is finding where in a
 * heading a stamp sits so the rest can be the label, which a date library does
 * not answer -- it parses a string already isolated. `Date.parse` would then
 * reject an impossible date like `2026-13-45`, and a heading carrying one is
 * still plainly a progress entry: rejecting it would make this reader stricter
 * exactly where it is meant to be tolerant.
 *
 * The cost is that a heading containing a date-shaped substring for some other
 * reason reads as progress. On a dive document that is worth having.
 */
const SECTION_STAMP =
	/\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?/;

/** Separators a label is joined to a stamp with, in every shape seen so far. */
const LABEL_TRIM = /^[\s\-:]+|[\s\-:]+$/g;

export interface SectionHeading {
	/** The heading text beside the stamp, absent when the heading is only a stamp. */
	label?: string;
	stamp: string;
}

/**
 * Decomposes a `##` heading into its stamp and whatever else it says, or
 * `undefined` when it carries no stamp at all.
 *
 * **A progress entry is a section whose heading decomposes.** That is the whole
 * rule, and it is deliberately about shape rather than position: `## Brief`
 * sits first and `## Outcome` is written last by `land`, so "everything after
 * the brief" is wrong at both ends, and a `--free` dive has no brief to count
 * from. Deciding by shape needs no rule for either, and none for whatever
 * section is added next.
 *
 * The stamp is searched for rather than indexed at, so where a label sits does
 * not matter. Every shape on record parses: the `<label> <stamp>` that `jump`,
 * `land`, `test` and `bail` write, the bare stamp that `append-log.dive`
 * writes without a `--label` and that `jump` wrote before it took one, and the
 * hand-written `<date> -- <label>` that predates a command for writing these
 * at all.
 *
 * This is the only place a heading is interpreted. New shapes are added here
 * and every reader gains them at once.
 */
export function decomposeSectionHeading(heading: string): SectionHeading | undefined {
	const text = /^##\s+(.*?)\s*$/.exec(heading)?.[1];
	if (text === undefined) return undefined;
	const match = SECTION_STAMP.exec(text);
	if (!match) return undefined;
	const label = (text.slice(0, match.index) + text.slice(match.index + match[0].length))
		.replace(LABEL_TRIM, "")
		.trim();
	return label ? { label, stamp: match[0] } : { stamp: match[0] };
}

/** Whether a document carries any section a command or a hand logged progress in. */
export function hasLoggedSection(text: string): boolean {
	return text.split(/\r?\n/).some((line) => decomposeSectionHeading(line) !== undefined);
}

/**
 * The newest parseable progress-section timestamp, in epoch milliseconds.
 *
 * `decomposeSectionHeading` deliberately recognizes malformed, date-shaped
 * stamps as progress. Time comparisons cannot do that, so malformed stamps are
 * ignored here; a caller that needs proof of recent activity will consequently
 * treat a document carrying only malformed stamps as stale.
 */
export function latestLoggedSectionTime(text: string): number | undefined {
	let latest: number | undefined;
	for (const line of text.split(/\r?\n/)) {
		const heading = decomposeSectionHeading(line);
		if (!heading) continue;
		const parsed = Date.parse(heading.stamp);
		if (!Number.isFinite(parsed)) continue;
		if (latest === undefined || parsed > latest) latest = parsed;
	}
	return latest;
}

/**
 * Appends `## [<label> ]<iso timestamp>` plus a body to a kb doc on disk.
 * The optional label lets a caller keep its own heading text (`land`'s
 * "Land report") while still writing a section `decomposeSectionHeading`
 * reads back.
 */
export function appendTimestampedSection(docPath: string, body: string, label?: string): void {
	const text = readFileSync(docPath, "utf8");
	const iso = new Date().toISOString();
	const heading = label ? `## ${label} ${iso}` : `## ${iso}`;
	writeFileAtomic(docPath, `${text.trimEnd()}\n\n${heading}\n\n${body}\n`);
}
