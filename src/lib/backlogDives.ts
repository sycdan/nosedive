import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import {
	formatPath,
	MarkdownDoc,
	NosediveRc,
	parseMarkdownDoc,
	toPosixPath,
} from "./coreParsing.js";
import { KbDoc, ScopeRef, parseRawFrontmatterObject } from "./kbDocs.js";
import { uuidLike } from "./repoWorkspaceCore.js";
import {
	BacklogKbDisplayNode,
	BacklogKbEffort,
	appendBacklogKbEffortLine,
	effortHasParentLink,
	insertBacklogKbEffort,
	loadBacklogKbEfforts,
	posixRelPath,
	printCommandHelp,
	sortedBacklogKbChildren,
} from "./packageBacklog.js";
import { parseLinkRefs } from "./kbRefs.js";
import { gitOutput, quoteYamlString } from "./renderPlan.js";

export function appendBacklogKbDisplayNode(
	lines: string[],
	node: BacklogKbDisplayNode,
	depth = 0,
): void {
	if (!node.effort && depth === 0) {
		if (lines.at(-1) !== "") lines.push("");
		lines.push(`### ${titleFromSlug(node.slug)}`, "");
		for (const child of sortedBacklogKbChildren(node)) appendBacklogKbDisplayNode(lines, child, 0);
		if (lines.at(-1) !== "") lines.push("");
		return;
	}

	if (!node.effort) {
		lines.push(`${"  ".repeat(depth)}- **${titleFromSlug(node.slug)}**`);
		for (const child of sortedBacklogKbChildren(node))
			appendBacklogKbDisplayNode(lines, child, depth + 1);
		return;
	}

	appendBacklogKbEffortLine(lines, node.effort, depth);
	for (const child of sortedBacklogKbChildren(node))
		appendBacklogKbDisplayNode(lines, child, depth + 1);
}

/**
 * Every repo the backlog covers, as the union of its efforts' own scopes. The
 * memo is rebuilt from scratch on each `update-backlog`, so this is recomputed
 * rather than carried forward: a scope written on the memo by hand would not
 * survive the next run, and one that outlives the effort that justified it
 * would leave `record.dive --free` hydrating a repo nothing is working on.
 */
function backlogScopeRepoIds(efforts: BacklogKbEffort[], kbDocs: KbDoc[]): string[] {
	const repoIds = new Set<string>();
	for (const effort of efforts) {
		for (const scope of effort.doc.scopes) {
			if (scope.repoId !== ".") repoIds.add(scope.repoId);
		}
	}
	const nameById = new Map(kbDocs.map((doc) => [doc.id, doc.name]));
	return [...repoIds].sort((a, b) => (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b));
}

export function renderUpdatedBacklogMemo(
	rc: NosediveRc,
	memo: MarkdownDoc,
	memoId: string,
	kbDocs: KbDoc[],
): string {
	const efforts = loadBacklogKbEfforts(kbDocs);
	const root: BacklogKbDisplayNode = { slug: "", children: new Map() };
	for (const effort of efforts) insertBacklogKbEffort(root, effort);
	const scopeRepoIds = backlogScopeRepoIds(efforts, kbDocs);

	const topEfforts = efforts.filter((effort) => !effortHasParentLink(effort.doc));
	const links = topEfforts.map((effort) => ({
		[posixRelPath(rc.bridgeDir, effort.doc.path)]: { rel: "main-effort" },
	}));
	const lines = ["# Backlog", "", "## Current efforts", ""];
	if (efforts.length === 0) {
		lines.push("No current efforts.");
	} else {
		for (const node of sortedBacklogKbChildren(root)) appendBacklogKbDisplayNode(lines, node);
		while (lines.at(-1) === "") lines.pop();
	}

	const name = memo.fm.scalars.name || `backlog.${basename(rc.bridgeDir)}`;
	const gist = memo.fm.scalars.gist || `Current backlog for ${basename(rc.bridgeDir)}.`;
	return [
		"---",
		"kind: memo",
		`id: ${memoId}`,
		`name: ${quoteYamlString(name)}`,
		`gist: ${quoteYamlString(gist)}`,
		...(scopeRepoIds.length > 0
			? ["scopes:", ...scopeRepoIds.map((repoId) => `  - ${repoId}`)]
			: []),
		...(links.length > 0
			? [
					"links:",
					...links.flatMap((link) => {
						const [target, value] = Object.entries(link)[0]!;
						return [`  - ${target}:`, `      rel: ${value.rel}`];
					}),
				]
			: []),
		"---",
		"",
		`${lines.join("\n")}\n`,
	].join("\n");
}

/** The rendered body of the bridge's configured backlog memo. Shared by `dump-backlog` and `preflight`. */
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

export interface ListDivesOptions {
	effortRef: string;
	includeHistorical: boolean;
	json: boolean;
}

export interface ListedDive {
	id: string;
	name: string;
	gist: string;
	rel?: string;
	diver?: string;
	scopes: string[];
	tags: string[];
	source: string;
}

export interface ListDivesResult {
	effort: string;
	pending: ListedDive[];
	working: ListedDive[];
	historical: ListedDive[];
	warnings: string[];
}

export function parseListDivesArgs(args: string[], io: CommandIo): ListDivesOptions {
	let effortRef: string | undefined;
	let includeHistorical = false;
	let json = false;

	for (const arg of args) {
		if (arg === "--include-historical") {
			includeHistorical = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			printCommandHelp("list-dives", io);
			return { effortRef: "", includeHistorical, json };
		}
		if (arg.startsWith("--")) throw new Error(`unknown list-dives option: ${arg}`);
		if (effortRef) throw new Error(`unexpected list-dives argument: ${arg}`);
		effortRef = arg;
	}

	if (!effortRef) throw new Error("list-dives requires an effort id, kb path, or name");
	return { effortRef, includeHistorical, json };
}

export function diveDocs(kbDocs: KbDoc[]): KbDoc[] {
	return kbDocs.filter((doc) => doc.kind === "dive");
}

/**
 * Ids of kb docs the bridge has not committed. Invisible by design: a dive
 * still being framed belongs to whoever is framing it, and no other checkout
 * should see it until it has a name and a gist to be seen by.
 */
export function localOnlyKbDocIds(bridgeDir: string, kbDir: string): Set<string> {
	const rel = toPosixPath(relative(bridgeDir, kbDir)) || ".";
	const status = gitOutput(bridgeDir, [
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		rel,
	]);
	const ids = new Set<string>();
	for (const line of (status ?? "").split(/\r?\n/)) {
		// `XY <path>`, and a rename reads `XY <old> -> <new>`; the new path is the
		// one on disk, so it is the one whose id is uncommitted.
		const path = line.slice(3).trim().split(" -> ").at(-1) ?? "";
		if (!path.endsWith(".md")) continue;
		ids.add(basename(path, ".md"));
	}
	return ids;
}

export function formatScopeRef(scope: ScopeRef): string {
	const bits = [scope.repoId];
	if (scope.ref) bits.push(`@${scope.ref}`);
	if (scope.readOnly) bits.push(":ro");
	if (scope.path && scope.path !== ".") bits.push(` path=${toPosixPath(scope.path)}`);
	return bits.join("");
}

/**
 * `record.dive` writes `diver: null` rather than omitting the key when no
 * `--diver` is given, so an unheld dive reads back as the four-character string
 * `null`. Held-ness is asked often enough to be worth one place to ask it.
 */
export function diveDiver(doc: KbDoc): string | undefined {
	const diver = (doc.metaScalars.diver ?? "").trim();
	return diver && diver !== "null" ? diver : undefined;
}

/**
 * What a dive still needs before it is worth anything to anyone, read off the
 * file rather than tracked in a field. `local-only` is the exception and states
 * a fact rather than a need: an unframed dive is refused by the bridge's commit
 * gate, so it is not missing a commit, it is not allowed one yet.
 */
export function diveTags(doc: KbDoc, localOnlyIds: ReadonlySet<string>): string[] {
	const tags: string[] = [];
	if (!doc.name || doc.name === doc.id) tags.push("needs-name");
	if (!doc.gist.trim()) tags.push("needs-gist");
	if (!doc.hasBrief) tags.push("needs-brief");
	if (!doc.scopes.some((scope) => scope.repoId !== ".")) tags.push("needs-scopes");
	if (!diveDiver(doc)) tags.push("needs-diver");
	if (!doc.hasLog) tags.push("never-jumped");
	if (localOnlyIds.has(doc.id)) tags.push("local-only");
	return tags;
}

export function listedDive(doc: KbDoc, rel?: string, tags: string[] = []): ListedDive {
	return {
		id: doc.id,
		name: doc.name,
		gist: doc.gist,
		rel,
		diver: diveDiver(doc),
		scopes: doc.scopes
			.filter((scope) => scope.repoId !== ".")
			.map((scope) => formatScopeRef(scope)),
		tags,
		source: doc.relPath,
	};
}

/**
 * A dive names its effort in `meta.effort`, which may be the effort's UUID, a
 * bridge-root kb path such as `kb/<id>.md`, or its exact `name`. All three
 * have to agree with the effort doc being listed.
 */
export function sameEffortRef(effortRef: string | undefined, effort: KbDoc): boolean {
	if (!effortRef) return false;
	if (effortRef === effort.id || effortRef === effort.name) return true;
	return toPosixPath(effortRef) === effort.relPath;
}

export const DIVE_WORKING_RELS = new Set(["working", "reviewing"]);

export function collectListDives(
	effort: KbDoc,
	kbDocs: KbDoc[],
	includeHistorical: boolean,
): ListDivesResult {
	const links = effort.links;
	const dives = diveDocs(kbDocs);
	const divesById = new Map(dives.map((doc) => [doc.id, doc]));
	const kbIds = new Set(kbDocs.map((doc) => doc.id));
	const effortLabel = effort.name;

	const pending: ListedDive[] = [];
	const working: ListedDive[] = [];
	const provenance: ListedDive[] = [];
	const warnings: string[] = [];
	const linkedDiveIds = new Set<string>();

	for (const link of links) {
		const dive = divesById.get(link.id);
		if (!dive) {
			// A rel-tagged link asserts a pickupable/working dive, so a missing
			// target is a broken dive ref worth surfacing. Bare provenance links
			// to non-dive docs are ignored here.
			if (link.rel && !kbIds.has(link.id)) {
				warnings.push(`dive link ${link.id} is missing from kb`);
			}
			continue;
		}
		if (!sameEffortRef(dive.effortRef, effort)) {
			warnings.push(`dive link ${link.id} does not point back at ${effortLabel}`);
			continue;
		}
		linkedDiveIds.add(dive.id);
		if (link.rel === "pending") {
			pending.push(listedDive(dive, link.rel));
		} else if (DIVE_WORKING_RELS.has(link.rel ?? "") || diveDiver(dive)) {
			working.push(listedDive(dive, link.rel));
		} else {
			provenance.push(listedDive(dive, link.rel));
		}
	}

	// Drift/superset scan: dives that name this effort but are not linked from it.
	// A held (diver set) unlinked dive is a workon-safety hazard, so warn; the
	// full progression view (--include-historical) also lists them.
	for (const dive of dives) {
		if (linkedDiveIds.has(dive.id)) continue;
		if (!sameEffortRef(dive.effortRef, effort)) continue;
		if (diveDiver(dive)) {
			warnings.push(
				`held dive ${dive.id} points at ${effortLabel} but is not linked from the effort`,
			);
		}
		provenance.push(listedDive(dive));
	}

	return {
		effort: effortLabel,
		pending,
		working,
		historical: includeHistorical ? provenance : [],
		warnings,
	};
}

/**
 * A markdown link rather than a bare id: the path is ctrl-clickable from a
 * terminal, and anyone reading the output later can follow it to the scopes and
 * brief this line deliberately does not restate. The effort is left off for the
 * same reason -- a managed dive name already carries the feat slug.
 */
export function formatListedDive(dive: ListedDive): string {
	const rel = dive.rel ? ` rel=${dive.rel}` : "";
	const diver = dive.diver ? ` diver=${dive.diver}` : "";
	const needs = dive.tags.filter((tag) => tag.startsWith("needs-"));
	const states = dive.tags.filter((tag) => !tag.startsWith("needs-"));
	const needsPart =
		needs.length > 0 ? ` needs=${needs.map((tag) => tag.slice("needs-".length)).join(",")}` : "";
	const statePart = states.length > 0 ? ` ${states.join(" ")}` : "";
	const gist = dive.gist ? ` - ${dive.gist}` : "";
	return `  - [${dive.name}](${dive.source})${rel}${diver}${needsPart}${statePart}${gist}`;
}

export function appendDiveSection(lines: string[], label: string, dives: ListedDive[]): void {
	lines.push(`${label}:`);
	if (dives.length === 0) {
		lines.push("  (none)");
		return;
	}
	for (const dive of dives) lines.push(formatListedDive(dive));
}

export function formatListDivesResult(result: ListDivesResult, includeHistorical: boolean): string {
	const lines = [`Effort: ${result.effort}`];
	appendDiveSection(lines, "Pending", result.pending);
	appendDiveSection(lines, "Working", result.working);
	if (includeHistorical) appendDiveSection(lines, "Historical", result.historical);
	if (result.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of result.warnings) lines.push(`  - ${warning}`);
	}
	return lines.join("\n");
}

export function pascalFromSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join("");
}

export function titleFromSlug(slug: string): string {
	return slug
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
}

export function assertSlug(slug: string, label: string): string {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new Error(`${label} must be kebab-case: ${slug}`);
	}
	return slug;
}

export function isInsideDir(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
