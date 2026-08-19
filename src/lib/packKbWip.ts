import { relative } from "node:path";

import { toPosixPath } from "./coreParsing.js";
import { runGit } from "./gitProcess.js";

export interface DirtyKbEntry {
	statusCode: string;
	path: string;
}

/**
 * Plain `--porcelain` C-quotes paths with spaces/non-ASCII (`core.quotePath`)
 * and joins a rename/copy as one `XY orig -> new` line -- naive
 * `split(/\r?\n/)` + `slice(3)` mis-parses both. `-z` NUL-delimits instead
 * (no quoting; a rename/copy becomes two separate records), same pattern
 * as `statusEntries` in `proveCore.ts`. `--untracked-files=all` stops an
 * entirely-untracked directory from collapsing into one directory line.
 */
export function dirtyKbEntries(bridgeDir: string, kbDir: string): DirtyKbEntry[] {
	const kbRel = toPosixPath(relative(bridgeDir, kbDir));
	const result = runGit(bridgeDir, [
		"status",
		"--porcelain",
		"-z",
		"--untracked-files=all",
		"--",
		kbRel,
	]);
	const records = result.stdout.split("\0").filter(Boolean);
	const entries: DirtyKbEntry[] = [];
	for (let i = 0; i < records.length; i += 1) {
		const record = records[i]!;
		const statusCode = record.slice(0, 2);
		// Skip a rename/copy's orig-path record, its own NUL-terminated entry.
		if (statusCode.includes("R") || statusCode.includes("C")) i += 1;
		entries.push({ statusCode, path: record.slice(3) });
	}
	return entries;
}

/**
 * The dive's own doc and its feat are the dive's context, not its cargo: both
 * are rewritten by the pack itself and neither belongs in the patch. Fresh
 * patch artifacts are excluded for the same reason -- this run just wrote them.
 */
export function excludedKbPaths(
	bridgeDir: string,
	divePath: string,
	featPath: string | undefined,
	excludeAbsPaths: string[],
): Set<string> {
	const absPaths = [divePath, ...(featPath ? [featPath] : []), ...excludeAbsPaths];
	return new Set(absPaths.map((path) => toPosixPath(relative(bridgeDir, path))));
}

/**
 * One hop, deliberately: a memo the dive links may link a third doc, and that
 * third doc is not thereby the dive's. Membership is decided on the link
 * *target* rather than on `LinkRef.id`, because `linkDocId` only yields a uuid
 * for a `kb/<uuid>.md` target and keeps any other target verbatim -- a target
 * such as `kb/space name.md` has to compare as the path it is.
 */
export function linkedKbPaths(linkTargets: string[]): Set<string> {
	return new Set(linkTargets.map((target) => toPosixPath(target)));
}

/**
 * A pack that swept the whole `kb/` directory made the dive claim every memo a
 * pilot happened to touch while it was open -- committed under the dive's own
 * `packed wip` and replayed onto whatever machine next jumped it. Refusing here
 * rather than at capture time keeps the decision ahead of the scope loop, so a
 * refused pack leaves no orphan `.patch` artifacts behind.
 */
export function assertDiveOwnsDirtyKb(
	entries: DirtyKbEntry[],
	excluded: Set<string>,
	linked: Set<string>,
): void {
	const unlinked = entries
		.map((entry) => entry.path)
		.filter((path) => !excluded.has(path) && !linked.has(path));
	if (unlinked.length === 0) return;
	throw new Error(
		[
			"refusing to pack: the bridge kb/ is dirty in paths this dive does not link:",
			...unlinked.map((path) => `  ${path}`),
			"a dive packs only what it links -- either link each path from the dive, or commit it to the bridge yourself",
		].join("\n"),
	);
}
