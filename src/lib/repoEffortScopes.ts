import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import {
	NosediveRc,
	formatPath,
	parseMarkdownFrontmatter,
	splitMarkdownFrontmatter,
	stringifyYaml,
	toPosixPath,
} from "./coreParsing.js";
import { EffortRepo, KbDoc, readActiveDiveId } from "./kbDocs.js";
import { parseScopeRefs } from "./proveHostRender.js";
import { writeFileAtomic } from "./renderPlan.js";

export function effortDocs(kbDocs: KbDoc[]): KbDoc[] {
	return kbDocs.filter((doc) => doc.kind === "effort");
}

export function resolveEffortDoc(kbDocs: KbDoc[], rc: NosediveRc, effortRef: string): KbDoc {
	const efforts = effortDocs(kbDocs);
	const byId = efforts.filter((doc) => doc.id === effortRef);
	if (byId.length === 1) return byId[0];

	const normalizedRef = toPosixPath(effortRef);
	const pathCandidates = [
		resolve(process.cwd(), effortRef),
		resolve(rc.bridgeDir, effortRef),
		rc.kbDir ? resolve(rc.kbDir, effortRef) : undefined,
	].filter((candidate): candidate is string => candidate !== undefined);
	const byPath = efforts.filter(
		(doc) =>
			doc.relPath === normalizedRef ||
			pathCandidates.some((candidate) => resolve(doc.path) === candidate),
	);
	if (byPath.length === 1) return byPath[0];
	if (byPath.length > 1) {
		throw new Error(
			`effort path is ambiguous: ${effortRef} (${byPath.map((doc) => doc.id).join(", ")})`,
		);
	}

	const byName = efforts.filter((doc) => doc.name === effortRef);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(
			`effort name is ambiguous: ${effortRef} (${byName.map((doc) => doc.id).join(", ")})`,
		);
	}
	throw new Error(`effort not found: ${effortRef}`);
}

/**
 * The active effort comes from the workspace dive marker and nowhere else.
 * There is no per-developer "current effort" setting: selecting a dive is how
 * a pilot says what they are working on, so anything else would be a second
 * source of truth that can disagree with it.
 */
export function resolveActiveEffortDoc(kbDocs: KbDoc[], rc: NosediveRc): KbDoc {
	const activeDiveId = readActiveDiveId(rc.workspaceDir);
	if (!activeDiveId) {
		throw new Error(
			"no active dive: this command needs an effort, which comes from the dive named in workspace/.nosedive-ref",
		);
	}

	const activeDive = kbDocs.find((doc) => doc.kind === "dive" && doc.id === activeDiveId);
	if (!activeDive) throw new Error(`active dive ${activeDiveId} is missing from kb`);
	if (!activeDive.effortRef) {
		throw new Error(`active dive ${activeDiveId} names no effort in meta.effort`);
	}

	return resolveEffortDoc(kbDocs, rc, activeDive.effortRef);
}

/**
 * Parent and child efforts link both ways, the same shape the L1 migration
 * generates, so a doc pitched under a parent is indistinguishable from a
 * migrated one.
 */
export function appendLinkToDoc(path: string, targetId: string, rel: string): void {
	const text = readFileSync(path, "utf8");
	const label = formatPath(path);
	const frontmatter = splitMarkdownFrontmatter(text, label);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0)
		throw new Error(
			`invalid YAML in frontmatter in ${label}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);

	const entry = { [`kb/${targetId}.md`]: { rel } };
	const links = doc.get("links", true);
	if (links === undefined || links === null) {
		doc.set("links", [entry]);
	} else if (isSeq(links)) {
		links.add(entry);
	} else {
		throw new Error(`invalid links in ${label}: expected a YAML list`);
	}

	writeFileAtomic(path, ["---", stringifyYaml(doc).trimEnd(), "---", frontmatter.body].join("\n"));
}

function linkTarget(entry: unknown): string | undefined {
	if (!isMap(entry) || entry.items.length !== 1) return undefined;
	const key = entry.items[0]?.key;
	return isScalar(key) && typeof key.value === "string" ? key.value : undefined;
}

function reconcileDiveLink(path: string, diveId: string, rel: string | undefined): void {
	const text = readFileSync(path, "utf8");
	const label = formatPath(path);
	const frontmatter = splitMarkdownFrontmatter(text, label);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0) {
		throw new Error(
			`invalid YAML in frontmatter in ${label}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);
	}

	const target = `kb/${diveId}.md`;
	const links = doc.get("links", true);
	if (links !== undefined && links !== null && !isSeq(links)) {
		throw new Error(`invalid links in ${label}: expected a YAML list`);
	}
	if (isSeq(links)) links.items = links.items.filter((entry) => linkTarget(entry) !== target);
	if (rel) {
		const entry = { [target]: { rel } };
		if (isSeq(links)) links.add(entry);
		else doc.set("links", [entry]);
	}

	writeFileAtomic(path, ["---", stringifyYaml(doc).trimEnd(), "---", frontmatter.body].join("\n"));
}

/** Keep an effort's dive index aligned with the dive's current assignment. */
export function reconcileDiveEffortLinks(
	previousEffort: KbDoc | undefined,
	effort: KbDoc,
	diveId: string,
	diver: string | undefined,
): void {
	if (previousEffort && previousEffort.id !== effort.id)
		reconcileDiveLink(previousEffort.path, diveId, undefined);
	reconcileDiveLink(effort.path, diveId, diver ? "working" : "pending");
}

export function formatEffortScopeEntry(
	repoId: string,
	ref: string | undefined,
	readOnly: boolean,
): string {
	return `${repoId}${ref ? `@${ref}` : ""}:${readOnly ? "ro" : "rw"}`;
}

export function appendRepoScopeToEffort(path: string, repo: EffortRepo): string {
	const text = readFileSync(path, "utf8");
	const label = formatPath(path);
	const rawScopes = parseMarkdownFrontmatter(text, label).raw.scopes;
	const existing = parseScopeRefs(rawScopes, path);
	if (existing.some((entry) => entry.repoId === repo.id)) {
		throw new Error(`effort already includes scope ${repo.id}: ${formatPath(path)}`);
	}

	const frontmatter = splitMarkdownFrontmatter(text, label);
	const entry = formatEffortScopeEntry(repo.id, repo.ref, repo.readOnly);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0)
		throw new Error(
			`invalid YAML in frontmatter in ${label}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);

	const scopeValue: Record<string, string> = {};
	if (repo.ref) scopeValue.ref = repo.ref;
	scopeValue.mode = repo.readOnly ? "ro" : "rw";
	const scopeEntry = { [repo.id]: scopeValue };
	const scopes = doc.get("scopes", true);
	if (scopes === undefined || scopes === null) {
		doc.set("scopes", [scopeEntry]);
	} else if (isSeq(scopes)) {
		scopes.add(scopeEntry);
	} else {
		throw new Error(`invalid effort scopes in ${label}: expected a YAML list`);
	}

	const yaml = stringifyYaml(doc);
	writeFileAtomic(path, ["---", yaml.trimEnd(), "---", frontmatter.body].join("\n"));
	return entry;
}
