import { readFileSync } from "node:fs";

import { writeFileAtomic } from "./renderPlan.js";

/**
 * Matches any section heading a `appendTimestampedSection` call produced,
 * with or without a label -- `## Land report <iso>` and a bare `## <iso>`
 * alike. Lets a reader detect "has this doc ever had such a section
 * appended" (e.g. `never-jumped`) without caring which caller wrote it.
 */
export const TIMESTAMPED_SECTION_HEADING_PATTERN =
	/^##\s+(?:\S.*\s)?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*$/m;

/**
 * Appends `## [<label> ]<iso timestamp>` plus a body to a kb doc on disk.
 * The optional label lets a caller keep its own heading text (`land`'s
 * "Land report") while still writing a section this module's pattern can
 * detect.
 */
export function appendTimestampedSection(docPath: string, body: string, label?: string): void {
	const text = readFileSync(docPath, "utf8");
	const iso = new Date().toISOString();
	const heading = label ? `## ${label} ${iso}` : `## ${iso}`;
	writeFileAtomic(docPath, `${text.trimEnd()}\n\n${heading}\n\n${body}\n`);
}
