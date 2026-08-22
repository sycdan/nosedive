import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
	formatPath,
	parseMarkdownDoc,
	parseYamlBlock,
	splitMarkdownFrontmatter,
	uuidLike,
	type MarkdownFrontmatterBlock,
	type NosediveRc,
} from "./coreParsing.js";
import { KbDoc, LinkRef } from "./kbDocs.js";
import { parseLinkRefs } from "./kbRefs.js";
import { relParts } from "./relGrammar.js";
import { titleFromSlug } from "./slugs.js";
import { writeFileAtomic } from "./renderPlan.js";
import { CommandIo } from "./bridgeSetupIo.js";
import {
	backlogDocTitle,
	backlogEntryLine,
	firstMarkdownHeading,
	posixRelPath,
} from "./packageBacklog.js";

/**
 * The roles a backlog edge may name to mean "this is work". `effort` is the
 * old spelling of `feat`: it is accepted on read because it is still written
 * across live bridges, and is never written by this tool.
 */
const FEAT_ROLES = new Set(["feat", "effort"]);

/** The rel `--inject` appends. Its predicate is what names the section. */
export const INJECT_REL = "injected.feat";

function isFeatRole(role: string | undefined): boolean {
	return role !== undefined && FEAT_ROLES.has(role);
}

/** A backlog root: any link on the memo whose rel names a feat-like role. */
function isBacklogRootRel(rel: string | undefined): boolean {
	return isFeatRole(relParts(rel)?.role);
}

function isEdgeRel(rel: string | undefined, predicate: string): boolean {
	const parts = relParts(rel);
	return parts?.predicate === predicate && (parts.role === undefined || isFeatRole(parts.role));
}

/**
 * A doc named by a backlog edge. `dive` and `repo` are managed kinds -- a
 * backlog that renders one is describing something that is not work, so say
 * which link did it rather than printing it as an item.
 */
function backlogEdgeTarget(source: string, link: LinkRef, byId: Map<string, KbDoc>): KbDoc {
	const rel = link.rel ?? "(no rel)";
	const doc = byId.get(link.id);
	if (!doc) throw new Error(`backlog link in ${source} names an unknown doc: ${link.id} (${rel})`);
	if (isManagedKind(doc.kind)) {
		throw new Error(
			`backlog link in ${source} names a kind: ${doc.kind} doc, which is not work: ${link.id} (${rel})`,
		);
	}
	return doc;
}

/** `dive` and `repo` are managed kinds. Whatever they link, they are not work. */
function isManagedKind(kind: string): boolean {
	return kind === "dive" || kind === "repo";
}

/**
 * The children of a node: its own `child.feat` links, and nothing else.
 *
 * `child.feat` is the only edge that means open work. Every other predicate on
 * a `.feat` edge is reference -- it records a relation without claiming the
 * target is open -- so a node's own links are the whole statement about what
 * hangs below it.
 *
 * Discovery in the other direction is deliberately absent. A doc pointing back
 * with `parent.feat` was once picked up here too, which meant a parent could
 * never take finished work off the backlog: whatever it wrote, the child's own
 * link put the child back. Openness is a claim the pointing node makes, so the
 * node that can no longer see the work as open has to be the one holding the
 * edge.
 *
 * The cost is that filing is two writes rather than one. `pitch --parent`
 * already does both, so nothing that files work through nosedive notices.
 */
function backlogChildren(node: KbDoc, byId: Map<string, KbDoc>): KbDoc[] {
	const children = new Map<string, KbDoc>();
	for (const link of node.links) {
		if (!isEdgeRel(link.rel, "child")) continue;
		const child = backlogEdgeTarget(node.relPath, link, byId);
		children.set(child.id, child);
	}
	return [...children.values()].sort((a, b) =>
		backlogDocTitle(a).localeCompare(backlogDocTitle(b)),
	);
}

function appendBacklogSubtree(
	lines: string[],
	doc: KbDoc,
	depth: number,
	byId: Map<string, KbDoc>,
	rendered: Set<string>,
	ancestors: string[],
): void {
	if (ancestors.includes(doc.id)) {
		throw new Error(`backlog child links form a cycle: ${[...ancestors, doc.id].join(" -> ")}`);
	}
	if (rendered.has(doc.id)) return;
	rendered.add(doc.id);
	lines.push(backlogEntryLine(doc, depth));
	for (const child of backlogChildren(doc, byId)) {
		appendBacklogSubtree(lines, child, depth + 1, byId, rendered, [...ancestors, doc.id]);
	}
}

/**
 * Every repo the rendered backlog covers, as the union of the scopes of the
 * docs it actually shows. Derived rather than hand-kept so `record.dive --free`
 * never hydrates a repo the backlog stopped naming, but spliced rather than
 * rewritten so a scope that survives keeps whatever was written on it.
 */
function backlogScopeRepoIds(docs: KbDoc[], kbDocs: KbDoc[]): string[] {
	const repoIds = new Set<string>();
	for (const doc of docs) {
		for (const scope of doc.scopes) {
			if (scope.repoId !== ".") repoIds.add(scope.repoId);
		}
	}
	const nameById = new Map(kbDocs.map((doc) => [doc.id, doc.name]));
	return [...repoIds].sort((a, b) => (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b));
}

/**
 * The raw lines of each existing `scopes:` entry, by repo id. Read as text
 * because a scope carries an open set of keys -- `note:` among them -- that no
 * parsed shape keeps, and a rewrite that dropped them would lose the pilot's
 * own words on every run.
 */
function rawScopeEntries(yamlLines: string[]): Map<string, string[]> {
	const entries = new Map<string, string[]>();
	const start = yamlLines.findIndex((line) => /^scopes:/.test(line));
	if (start < 0) return entries;

	let id: string | undefined;
	let buffer: string[] = [];
	const flush = (): void => {
		if (id) entries.set(id, buffer);
		id = undefined;
		buffer = [];
	};
	for (const line of yamlLines.slice(start + 1)) {
		if (/^\S/.test(line)) break;
		const entry = /^\s*-\s+(.+?)\s*$/.exec(line);
		if (entry) {
			flush();
			id = entry[1]!.replace(/:$/, "").trim();
		}
		if (id) buffer.push(line);
	}
	flush();
	return entries;
}

/**
 * Rewrite the `scopes:` block to the derived set, carrying each surviving
 * entry's own lines across so keys nothing parses -- `note:` among them --
 * outlive the run. A derivation of nothing is no information rather than a
 * verdict: feats routinely carry no scopes at all, so an empty set leaves
 * whatever the memo already said alone instead of deleting it.
 */
function spliceScopes(
	yamlLines: string[],
	repoIds: string[],
	existing: Map<string, string[]>,
): string[] {
	if (repoIds.length === 0) return yamlLines;
	const block = [
		"scopes:",
		...repoIds.flatMap((repoId) => existing.get(repoId) ?? [`  - ${repoId}`]),
	];

	const start = yamlLines.findIndex((line) => /^scopes:/.test(line));
	if (start < 0) {
		const links = yamlLines.findIndex((line) => /^links:/.test(line));
		const at = links < 0 ? yamlLines.length : links;
		return [...yamlLines.slice(0, at), ...block, ...yamlLines.slice(at)];
	}
	let end = start + 1;
	while (end < yamlLines.length && !/^\S/.test(yamlLines[end]!)) end += 1;
	return [...yamlLines.slice(0, start), ...block, ...yamlLines.slice(end)];
}

/**
 * Append `rel: injected.feat` links for docs the memo does not already carry as
 * work. Appending is the whole contract: an existing link's rel is the pilot's
 * own filing and is never rewritten to match the flag.
 */
export function injectBacklogLinks(
	yamlLines: string[],
	bridgeDir: string,
	docs: KbDoc[],
	alreadyLinked: (doc: KbDoc) => boolean,
): { lines: string[]; injected: KbDoc[]; skipped: KbDoc[] } {
	const injected = docs.filter((doc) => !alreadyLinked(doc));
	const skipped = docs.filter((doc) => alreadyLinked(doc));
	if (injected.length === 0) return { lines: yamlLines, injected, skipped };

	const added = injected.flatMap((doc) => [
		`  - ${posixRelPath(bridgeDir, doc.path)}:`,
		`      rel: ${INJECT_REL}`,
	]);
	const start = yamlLines.findIndex((line) => /^links:/.test(line));
	if (start < 0) return { lines: [...yamlLines, "links:", ...added], injected, skipped };
	let end = start + 1;
	while (end < yamlLines.length && !/^\S/.test(yamlLines[end]!)) end += 1;
	return {
		lines: [...yamlLines.slice(0, end), ...added, ...yamlLines.slice(end)],
		injected,
		skipped,
	};
}

export function backlogMemoHasWorkLink(yamlLinks: LinkRef[], doc: KbDoc): boolean {
	return yamlLinks.some((link) => link.id === doc.id && isBacklogRootRel(link.rel));
}

export { isBacklogRootRel };

/**
 * The backlog body, rendered from the memo's own links and nothing else. The
 * memo names its roots; each root's child edges name the rest. Nothing is
 * discovered by scanning the kb for a kind, so a doc appears here because
 * somebody linked it, not because of what it is called.
 */
export function renderUpdatedBacklogMemo(
	memoText: string,
	memoPath: string,
	kbDocs: KbDoc[],
	injectYamlLines?: string[],
): string {
	const label = formatPath(memoPath);
	const block: MarkdownFrontmatterBlock = splitMarkdownFrontmatter(memoText, label);
	const yamlLines = injectYamlLines ?? block.yaml.split(/\r?\n/);
	const fm = parseYamlBlock(yamlLines.join("\n"), `frontmatter in ${label}`);

	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const roots = parseLinkRefs(fm.raw.links, memoPath).filter((link) => isBacklogRootRel(link.rel));

	const sections = new Map<string, KbDoc[]>();
	for (const link of roots) {
		const predicate = relParts(link.rel)!.predicate;
		const doc = backlogEdgeTarget(label, link, byId);
		sections.set(predicate, [...(sections.get(predicate) ?? []), doc]);
	}

	const rendered = new Set<string>();
	const shown: KbDoc[] = [];
	const fallback = titleFromSlug((fm.scalars.name || "backlog").split(".")[0]!);
	const lines = [`# ${firstMarkdownHeading(block.body, fallback)}`];
	for (const predicate of [...sections.keys()].sort((a, b) => a.localeCompare(b))) {
		const docs = [...sections.get(predicate)!].sort((a, b) =>
			backlogDocTitle(a).localeCompare(backlogDocTitle(b)),
		);
		const section: string[] = [];
		for (const doc of docs) {
			appendBacklogSubtree(section, doc, 0, byId, rendered, []);
		}
		if (section.length === 0) continue;
		lines.push("", `## ${titleFromSlug(predicate)}`, "", ...section);
	}
	if (rendered.size === 0) lines.push("", "The backlog links no work.");
	for (const id of rendered) shown.push(byId.get(id)!);

	const scoped = spliceScopes(
		yamlLines,
		backlogScopeRepoIds(shown, kbDocs),
		rawScopeEntries(yamlLines),
	);
	return ["---", ...scoped, "---", "", `${lines.join("\n")}\n`].join("\n");
}

/**
 * Inject already-resolved docs into the bridge's configured backlog memo,
 * writing the result and logging what happened. Shared by `update-backlog
 * --inject` and `pitch`, which calls this itself for an unparented feat so a
 * pilot who never runs `update-backlog` by hand still gets a reachable feat.
 */
export function injectDocsIntoBacklogMemo(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	targets: KbDoc[],
	io: { log(message: string): void },
): void {
	const memoId = rc.backlog;
	if (!memoId) throw new Error("update-backlog requires a configured backlog memo id");
	if (!uuidLike(memoId))
		throw new Error(`update-backlog requires a UUID-shaped backlog memo id: ${memoId}`);
	if (!rc.kbDir) throw new Error("update-backlog requires a configured kb directory");

	const memoPath = join(rc.kbDir, `${memoId}.md`);
	if (!existsSync(memoPath)) throw new Error(`bridge backlog memo not found: ${memoId}`);
	if (!statSync(memoPath).isFile()) throw new Error(`bridge backlog memo is not a file: ${memoId}`);

	for (const target of targets) {
		if (target.id === memoId) throw new Error("--inject cannot inject the backlog memo itself");
		if (target.kind === "dive" || target.kind === "repo") {
			throw new Error(`--inject names a kind: ${target.kind} doc, which is not work: ${target.id}`);
		}
	}

	const memoText = readFileSync(memoPath, "utf8");
	let yamlLines: string[] | undefined;
	if (targets.length > 0) {
		const existing = parseLinkRefs(
			parseMarkdownDoc(memoText, formatPath(memoPath)).fm.raw.links,
			memoPath,
		);
		const result = injectBacklogLinks(
			splitMarkdownFrontmatter(memoText, formatPath(memoPath)).yaml.split(/\r?\n/),
			rc.bridgeDir,
			targets,
			(doc) => backlogMemoHasWorkLink(existing, doc),
		);
		yamlLines = result.lines;
		for (const doc of result.injected) io.log(`Injected ${doc.relPath}`);
		for (const doc of result.skipped) io.log(`Already on the backlog: ${doc.relPath}`);
	}

	const content = renderUpdatedBacklogMemo(memoText, memoPath, kbDocs, yamlLines);
	writeFileAtomic(memoPath, content);
	io.log(`Updated backlog memo: ${posixRelPath(rc.bridgeDir, memoPath)}`);
}
export function bridgeBacklogMemoBody(rc: NosediveRc): string {
	const id = rc.backlog;
	if (!id) throw new Error("dump-backlog requires a configured backlog memo id");
	if (!uuidLike(id)) throw new Error(`dump-backlog requires a UUID-shaped backlog memo id: ${id}`);
	if (!rc.kbDir) throw new Error("dump-backlog requires a configured kb directory");

	const docPath = join(rc.kbDir, `${id}.md`);
	if (!existsSync(docPath)) throw new Error(`bridge backlog memo not found: ${id}`);
	if (!statSync(docPath).isFile()) throw new Error(`bridge backlog memo is not a file: ${id}`);
	return parseMarkdownDoc(readFileSync(docPath, "utf8"), formatPath(docPath)).body;
}
