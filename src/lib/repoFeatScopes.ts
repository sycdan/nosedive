import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

import {
	NosediveRc,
	formatPath,
	parseMarkdownDoc,
	parseMarkdownFrontmatter,
	splitMarkdownFrontmatter,
	stringifyYaml,
	toPosixPath,
} from "./coreParsing.js";
import { diveDiver } from "./diveListing.js";
import { KbDoc, readActiveDiveId } from "./kbDocs.js";
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
export function appendLinkToDoc(
	path: string,
	targetId: string,
	rel: string,
	/**
	 * Extra keys beside `rel`, for edges whose attributes are the caller's to set.
	 * Scalars rather than strings, so a number writes unquoted the way a
	 * hand-written link does -- both spellings read back the same.
	 */
	attrs: Record<string, string | number | boolean> = {},
): void {
	const text = readFileSync(path, "utf8");
	const label = formatPath(path);
	const frontmatter = splitMarkdownFrontmatter(text, label);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0)
		throw new Error(
			`invalid YAML in frontmatter in ${label}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);

	const entry = { [`kb/${targetId}.md`]: { rel, ...attrs } };
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

function newLinkAttrs(
	rel: string,
	attrs: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = { rel };
	for (const [key, value] of Object.entries(attrs)) {
		if (key !== "rel" && value !== null) result[key] = value;
	}
	return result;
}

/**
 * Make the document's link to `targetId` say exactly `rel`, or remove it when
 * no rel is given. Unlike `appendLinkToDoc` this is idempotent: it replaces the
 * entry rather than adding a second one, which is what an edit needs.
 *
 * A replacement keeps the position the entry already had. Appending instead
 * would say the same thing, but every phase change on a dive would read as a
 * line deleted from the middle of its feat and another added at the bottom,
 * and the index would drift into last-touched order nobody chose.
 */
export function reconcileDocLink(
	path: string,
	targetId: string,
	rel: string | undefined,
	/**
	 * Keys supplied here update the existing edge. A null explicitly removes a
	 * key; omitted keys are deliberately left as the pilot wrote them.
	 */
	attrs: Record<string, string | number | boolean | null> = {},
): void {
	const text = readFileSync(path, "utf8");
	const label = formatPath(path);
	const frontmatter = splitMarkdownFrontmatter(text, label);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0) {
		throw new Error(
			`invalid YAML in frontmatter in ${label}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);
	}

	const target = `kb/${targetId}.md`;
	const links = doc.get("links", true);
	if (links !== undefined && links !== null && !isSeq(links)) {
		throw new Error(`invalid links in ${label}: expected a YAML list`);
	}
	if (!isSeq(links)) {
		if (rel) doc.set("links", [{ [target]: newLinkAttrs(rel, attrs) }]);
	} else {
		// Every occurrence goes, so a document that somehow carries the target
		// twice comes back with one edge, as it did before.
		const at = links.items.findIndex((item) => linkTarget(item) === target);
		if (!rel) {
			links.items = links.items.filter((item) => linkTarget(item) !== target);
		} else if (at === -1) {
			links.add({ [target]: newLinkAttrs(rel, attrs) });
		} else {
			const existing = links.items[at];
			const value = isMap(existing) ? existing.items[0]?.value : undefined;
			if (!isMap(value)) {
				links.items.splice(at, 1, { [target]: newLinkAttrs(rel, attrs) });
			} else {
				value.set("rel", rel);
				for (const [key, attr] of Object.entries(attrs)) {
					if (attr === null) value.delete(key);
					else value.set(key, attr);
				}
			}
			links.items = links.items.filter(
				(item, index) => index === at || linkTarget(item) !== target,
			);
		}
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
		reconcileDocLink(previousFeat.path, diveId, undefined);
	reconcileDocLink(feat.path, diveId, rel);
}

/**
 * Move a dive's diver into its packer, in a frontmatter document the caller is
 * already editing. Two callers reach the same release: `pack`, which puts down
 * the dive the workspace is on, and `record.dive --packer`, which puts down one
 * recorded somewhere else. Returns whether anything was held, because a pack
 * with nothing captured still has to commit when it released a dive.
 */
export function releaseDiverInFrontmatter(doc: Document): boolean {
	const diver = doc.getIn(["meta", "diver"]);
	// `record.dive` writes `diver: null` rather than omitting the key, and a
	// hand-written dive may spell that as the four-character string.
	if (typeof diver !== "string" || !diver.trim() || diver.trim() === "null") return false;
	doc.setIn(["meta", "packer"], diver);
	doc.setIn(["meta", "diver"], null);
	return true;
}

/** `releaseDiverInFrontmatter` against a dive document on disk. */
export function releaseDiveToPacker(divePath: string): boolean {
	const text = readFileSync(divePath, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(divePath));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in frontmatter in ${formatPath(divePath)}`);
	if (!releaseDiverInFrontmatter(doc)) return false;
	writeFileAtomic(divePath, ["---", stringifyYaml(doc).trimEnd(), "---", parsed.body].join("\n"));
	return true;
}

/**
 * `--packer` does not put down the dive the workspace is on. Its worktrees were
 * hydrated from the state a release moves on from, and there is one way to put
 * down the dive you are flying: `pack`, which also clears the marker and resets
 * those worktrees.
 *
 * Only `--packer` asks. `--repin` used to as well, and that was wrong: moving a
 * pin edits a document and puts nothing down, so it is gated on the work a
 * scope's worktree holds rather than on which dive is active.
 */
export function ensureNotActiveDive(dive: KbDoc, active: KbDoc | undefined): void {
	if (active?.id !== dive.id) return;
	throw new Error(
		`dive ${dive.id} is the active workspace dive; \`pack\` is what puts it down -- ` +
			`its worktrees and marker were made from the state this would edit`,
	);
}

/**
 * Whether `--packer` may release this dive. Releasing is not a handover: it
 * hands the dive back to nobody, so only the pilot who holds it may do it, and
 * a dive nobody holds has nothing to release. Mirrors `--takeover`'s refusals,
 * which is the other command that reads the holder off the document.
 */
export function ensureReleasable(dive: KbDoc, pilotEmail: string, active: KbDoc | undefined): void {
	ensureNotActiveDive(dive, active);
	const heldBy = diveDiver(dive);
	if (!heldBy) throw new Error(`dive ${dive.id} is not held; there is nothing to release`);
	if (!pilotEmail) throw new Error("--packer requires git config user.email in the bridge");
	if (heldBy !== pilotEmail) {
		throw new Error(
			`dive ${dive.id} is held by ${heldBy}; only its diver can release it, or take it over with \`record.dive --ref ${dive.id} --takeover\``,
		);
	}
}

/**
 * What the feat now says about a repo, for the pilot to read back: the repo, the
 * ref it is pinned to, and the branch its dives push to. A scope with no branch
 * prints as bare, because that is what it is -- read-only, with nowhere for work
 * to go until somebody names a branch.
 */
export function formatFeatScopeEntry(
	repoId: string,
	ref: string | undefined,
	workBranch: string | undefined,
): string {
	return `${repoId}${ref ? `@${ref}` : ""}${workBranch ? `:${workBranch}` : ""}`;
}

export interface FeatScopeAddition {
	id: string;
	ref?: string;
	workBranch?: string;
}

export function appendRepoScopeToFeat(path: string, repo: FeatScopeAddition): string {
	const text = readFileSync(path, "utf8");
	const label = formatPath(path);
	const rawScopes = parseMarkdownFrontmatter(text, label).raw.scopes;
	const existing = parseScopeRefs(rawScopes, path);
	if (existing.some((entry) => entry.repoId === repo.id)) {
		throw new Error(`feat already includes scope ${repo.id}: ${formatPath(path)}`);
	}

	const frontmatter = splitMarkdownFrontmatter(text, label);
	const entry = formatFeatScopeEntry(repo.id, repo.ref, repo.workBranch);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0)
		throw new Error(
			`invalid YAML in frontmatter in ${label}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);

	// `mode` is never written. A feat scope declares where its dives push by
	// naming a branch, and declares read-only by naming none -- so a scope with
	// nothing to say beyond the repo is written as the repo, which is the bare
	// form the parser has always read as pinned to trunk and read-only.
	const scopeValue: Record<string, string> = {};
	if (repo.ref) scopeValue.ref = repo.ref;
	if (repo.workBranch) scopeValue["work-branch"] = repo.workBranch;
	const scopeEntry = Object.keys(scopeValue).length === 0 ? repo.id : { [repo.id]: scopeValue };
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
