import { relative } from "node:path";

import { toPosixPath } from "./coreParsing.js";
import { runGit } from "./gitProcess.js";
import type { KbDoc } from "./kbDocs.js";

export interface BundleMetaRole {
	match: RegExp;
	metaKeys: string[];
}

export const BUNDLE_META_PATHS_BY_ROLE: BundleMetaRole[] = [{ match: /\.gate$/, metaKeys: ["test-script"] }];

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

export function bundleMetaPathsForDoc(doc: KbDoc, rel?: string): string[] {
	const rules = rel !== undefined ? BUNDLE_META_PATHS_BY_ROLE.filter((rule) => rule.match.test(rel)) : [];
	if (rules.length === 0) return [];
	return rules
		.flatMap((rule) => rule.metaKeys)
		.map((key) => doc.metaScalars[key])
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.map((value) => toPosixPath(value));
}

export function followLinkedKbPaths(kbDocs: KbDoc[], linkTargets: string[], rels: string[] = []): Set<string> {
	const visited = new Set(linkTargets.map((target) => toPosixPath(target)));
	for (const [index, target] of linkTargets.entries()) {
		const rel = rels[index];
		const doc = kbDocs.find((entry) => entry.relPath === toPosixPath(target) || entry.id === target);
		if (!doc || !rel) continue;
		for (const path of bundleMetaPathsForDoc(doc, rel)) visited.add(toPosixPath(path));
	}
	return visited;
}

/**
 * A pack that swept the whole `kb/` directory could accidentally claim every memo
 * a pilot happened to touch while it was open. We still surface these as a
 * warning, but a pack ignores them unless they are linked or explicitly bundled
 * by a linked doc role. This keeps the capture decision ahead of the scope loop
 * without leaving half-written `.patch` artifacts behind on a refused run.
 */
export function assertDiveOwnsDirtyKb(
	entries: DirtyKbEntry[],
	excluded: Set<string>,
	linked: Set<string>,
): { unlinked: string[]; warned: string[] } {
	const unlinked = entries
		.map((entry) => entry.path)
		.filter((path) => !excluded.has(path) && !linked.has(path));
	if (unlinked.length === 0) return { unlinked: [], warned: [] };
	return { unlinked, warned: unlinked };
}
