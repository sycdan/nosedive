import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import {
	NosediveRc,
	formatPath,
	parseMarkdownDoc,
	parseMarkdownFrontmatter,
	splitMarkdownFrontmatter,
	stringifyYaml,
	toPosixPath,
} from "./coreParsing.js";
import { FeatRepo, KbDoc, readActiveDiveId } from "./kbDocs.js";
import { parseScopeRefs } from "./kbRefs.js";
import { writeFileAtomic } from "./renderPlan.js";

export function featDocs(kbDocs: KbDoc[]): KbDoc[] {
	return kbDocs.filter((doc) => doc.kind === "feat");
}

export function resolveFeatDoc(kbDocs: KbDoc[], rc: NosediveRc, featRef: string): KbDoc {
	const byId = kbDocs.filter((doc) => doc.id === featRef);
	if (byId.length === 1) return byId[0];

	const normalizedRef = toPosixPath(featRef);
	const pathCandidates = [
		resolve(process.cwd(), featRef),
		resolve(rc.bridgeDir, featRef),
		rc.kbDir ? resolve(rc.kbDir, featRef) : undefined,
	].filter((candidate): candidate is string => candidate !== undefined);
	const byPath = kbDocs.filter(
		(doc) =>
			doc.relPath === normalizedRef ||
			pathCandidates.some((candidate) => resolve(doc.path) === candidate),
	);
	if (byPath.length === 1) return byPath[0];
	if (byPath.length > 1) {
		throw new Error(
			`feat path is ambiguous: ${featRef} (${byPath.map((doc) => doc.id).join(", ")})`,
		);
	}

	const byName = kbDocs.filter((doc) => doc.name === featRef);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(
			`feat name is ambiguous: ${featRef} (${byName.map((doc) => doc.id).join(", ")})`,
		);
	}
	throw new Error(`feat not found: ${featRef}`);
}

/**
 * The active feat comes from the workspace dive marker and nowhere else.
 * There is no per-developer "current feat" setting: selecting a dive is how
 * a pilot says what they are working on, so anything else would be a second
 * source of truth that can disagree with it.
 */
export function resolveActiveFeatDoc(kbDocs: KbDoc[], rc: NosediveRc): KbDoc {
	const activeDiveId = readActiveDiveId(rc.workspaceDir);
	if (!activeDiveId) {
		throw new Error(
			"no active dive: this command needs a feat, which comes from the dive named in workspace/.nosedive-ref",
		);
	}

	const activeDive = kbDocs.find((doc) => doc.kind === "dive" && doc.id === activeDiveId);
	if (!activeDive) throw new Error(`active dive ${activeDiveId} is missing from kb`);
	if (!activeDive.featRef) {
		throw new Error(`active dive ${activeDiveId} names no feat in meta.feat`);
	}

	return resolveFeatDoc(kbDocs, rc, activeDive.featRef);
}

/**
 * Parent and child feats link both ways, the same shape the L1 migration
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

/**
 * Keep a feat's dive index aligned with the dive's current phase. The edge
 * records phase while claimed-ness is derived from `meta.diver`, so callers
 * must supply the rel instead of conflating the two states.
 */
export function reconcileDiveFeatLinks(
	previousFeat: KbDoc | undefined,
	feat: KbDoc,
	diveId: string,
	rel: string,
): void {
	if (previousFeat && previousFeat.id !== feat.id)
		reconcileDiveLink(previousFeat.path, diveId, undefined);
	reconcileDiveLink(feat.path, diveId, rel);
}

/** Release a dive while retaining its marker and any captured patch chains. */
export function clearDiveDiver(divePath: string): boolean {
	const text = readFileSync(divePath, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(divePath));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in frontmatter in ${formatPath(divePath)}`);
	if (!doc.getIn(["meta", "diver"])) return false;
	doc.setIn(["meta", "diver"], null);
	writeFileAtomic(divePath, ["---", stringifyYaml(doc).trimEnd(), "---", parsed.body].join("\n"));
	return true;
}

export function formatFeatScopeEntry(
	repoId: string,
	ref: string | undefined,
	readOnly: boolean,
): string {
	return `${repoId}${ref ? `@${ref}` : ""}:${readOnly ? "ro" : "rw"}`;
}

export function appendRepoScopeToFeat(path: string, repo: FeatRepo): string {
	const text = readFileSync(path, "utf8");
	const label = formatPath(path);
	const rawScopes = parseMarkdownFrontmatter(text, label).raw.scopes;
	const existing = parseScopeRefs(rawScopes, path);
	if (existing.some((entry) => entry.repoId === repo.id)) {
		throw new Error(`feat already includes scope ${repo.id}: ${formatPath(path)}`);
	}

	const frontmatter = splitMarkdownFrontmatter(text, label);
	const entry = formatFeatScopeEntry(repo.id, repo.ref, repo.readOnly);
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
		throw new Error(`invalid feat scopes in ${label}: expected a YAML list`);
	}

	const yaml = stringifyYaml(doc);
	writeFileAtomic(path, ["---", yaml.trimEnd(), "---", frontmatter.body].join("\n"));
	return entry;
}
