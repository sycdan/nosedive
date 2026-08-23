import { basename, relative } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import { NosediveRc, toPosixPath, uuidLike } from "./coreParsing.js";
import { KbDoc, ScopeRef } from "./kbDocs.js";
import { printCommandHelp } from "./packageBacklog.js";
import { gitOutput } from "./gitProcess.js";
import { titleFromSlug } from "./slugs.js";

export interface ListDivesOptions {
	/** A feat or a deck to constrain the listing to. Absent means the whole kb. */
	ref?: string;
	help: boolean;
	includeHistorical: boolean;
	json: boolean;
}

/** A feat, named the way a listing refers to one: a slug and a path to read. */
export interface FeatRef {
	name: string;
	source: string;
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
	/** The feat whose links reached this dive, absent when nothing owns it. */
	feat?: FeatRef;
	lastLog?: { label?: string; at: number };
}

/** Dives that share a feat, in the order the walk first reached that feat. */
export interface FeatDiveGroup {
	feat?: FeatRef;
	dives: ListedDive[];
}

export interface ListDivesResult {
	scope: string;
	pending: ListedDive[];
	working: ListedDive[];
	historical: ListedDive[];
	warnings: string[];
}

/** A dive and the rel of the edge it was found by, if it was found by an edge. */
export interface DiveLink {
	dive: KbDoc;
	rel?: string;
	/** The document whose links named the dive, when the dive was walked to. */
	owner?: KbDoc;
}

export function parseListDivesArgs(args: string[], io: CommandIo): ListDivesOptions {
	let ref: string | undefined;
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
			return { help: true, includeHistorical, json };
		}
		if (arg.startsWith("--")) throw new Error(`unknown list-dives option: ${arg}`);
		if (ref) throw new Error(`unexpected list-dives argument: ${arg}`);
		ref = arg;
	}

	return { ref, help: false, includeHistorical, json };
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
	// `:<branch>` says landable and says where. `:ro` said only the first half of
	// the opposite, and said it about a key nothing writes any more.
	if (scope.workBranch) bits.push(`:${scope.workBranch}`);
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
	if (localOnlyIds.has(doc.id)) tags.push("local-only");
	return tags;
}

export function listedDive(
	doc: KbDoc,
	rel?: string,
	tags: string[] = [],
	owner?: KbDoc,
): ListedDive {
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
		// Only a feat owns a dive. A deck links dives directly too, and that is
		// the one case a listing must not dress up as ownership.
		feat: owner?.kind === "feat" ? { name: owner.name, source: owner.relPath } : undefined,
		lastLog: doc.lastLog,
	};
}

const AGE_BUCKETS = [
	[365 * 24 * 60 * 60_000, "year"],
	[30 * 24 * 60 * 60_000, "month"],
	[7 * 24 * 60 * 60_000, "week"],
	[24 * 60 * 60_000, "day"],
	[60 * 60_000, "hour"],
	[60_000, "minute"],
] as const;

function humanizeAge(ms: number): string {
	for (const [size, unit] of AGE_BUCKETS) {
		if (ms < size) continue;
		const count = Math.floor(ms / size);
		return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
	}
	return "just now";
}

/**
 * What last happened to the dive, and when. The label is the section's own
 * heading text, printed as it was written: rewording it here would leave the
 * line and the section it names disagreeing. A clock that has gone backwards
 * since the section was written reads as "just now" rather than a negative age.
 */
function formatLastLog(lastLog: ListedDive["lastLog"]): string | undefined {
	if (!lastLog) return undefined;
	return `${lastLog.label ?? "logged"} ${humanizeAge(Math.max(0, Date.now() - lastLog.at))}`;
}

const BACKLOG_FEAT_RELS = new Set(["parent", "child"]);

function isBacklogFeatRel(rel: string | undefined): boolean {
	return Boolean(
		// `-effort` is the old spelling: accepted on read, never written.
		rel && (BACKLOG_FEAT_RELS.has(rel) || rel.endsWith("-effort") || rel.endsWith(".feat")),
	);
}

/**
 * Every dive a deck reaches, walking feat links out from it. A deck is any doc
 * that roots a backlog tree -- the configured backlog memo is one -- so the walk
 * is the same whether it starts at the bridge's deck or at one named on the
 * command line. First link to a dive wins: the same dive reached twice is one
 * dive, and the shallower edge is the one the reader was looking for.
 */
export function walkDeckDives(deck: KbDoc, kbDocs: KbDoc[]): DiveLink[] {
	const docsById = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const dives: DiveLink[] = [];
	const seenDocs = new Set<string>();
	const seenDives = new Set<string>();
	const queue = [deck];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (seenDocs.has(current.id)) continue;
		seenDocs.add(current.id);

		for (const link of current.links) {
			const target = docsById.get(link.id);
			if (!target) continue;
			if (target.kind === "dive") {
				if (seenDives.has(target.id)) continue;
				seenDives.add(target.id);
				dives.push({ dive: target, rel: link.rel, owner: current });
			} else if (target.kind !== "repo" && isBacklogFeatRel(link.rel)) {
				queue.push(target);
			}
		}
	}

	return dives;
}

/**
 * A dive names its feat in `meta.feat`, which may be the feat's UUID, a
 * bridge-root kb path such as `kb/<id>.md`, or its exact `name`. All three
 * have to agree with the feat doc being listed.
 */
export function sameFeatRef(featRef: string | undefined, feat: KbDoc): boolean {
	if (!featRef) return false;
	if (featRef === feat.id || featRef === feat.name) return true;
	return toPosixPath(featRef) === feat.relPath;
}

export const DIVE_PENDING_RELS = new Set(["planned", "pending"]);
export const DIVE_WORKING_RELS = new Set(["working", "reviewing", "jumped", "packed"]);

/**
 * A dive edge may carry its role as a suffix -- `planned.dive` -- or not, which
 * is what older `record.dive` versions wrote. Both name the same edge.
 */
export function diveRole(rel: string | undefined): string | undefined {
	if (!rel) return undefined;
	return rel.endsWith(".dive") ? rel.slice(0, -".dive".length) : rel;
}

/**
 * Which section a dive belongs in. The edge decides when there is one, because
 * a rel is a statement about the dive's phase; with no edge to read -- the
 * whole-kb listing has none -- `meta.diver` is the only thing left that says
 * whether anyone has picked the dive up.
 */
function diveBucket(dive: KbDoc, rel: string | undefined): "pending" | "working" | "historical" {
	const role = diveRole(rel);
	if (!role) return diveDiver(dive) ? "working" : "pending";
	if (DIVE_PENDING_RELS.has(role)) return "pending";
	if (DIVE_WORKING_RELS.has(role) || diveDiver(dive)) return "working";
	return "historical";
}

function listDivesResult(
	scope: string,
	links: DiveLink[],
	localOnlyIds: ReadonlySet<string>,
	includeHistorical: boolean,
	warnings: string[] = [],
): ListDivesResult {
	const buckets: Record<"pending" | "working" | "historical", ListedDive[]> = {
		pending: [],
		working: [],
		historical: [],
	};
	for (const { dive, rel } of links) {
		buckets[diveBucket(dive, rel)].push(listedDive(dive, rel, diveTags(dive, localOnlyIds)));
	}
	return {
		scope,
		pending: buckets.pending,
		working: buckets.working,
		historical: includeHistorical ? buckets.historical : [],
		warnings,
	};
}

/** Every `kind: dive` doc in the kb, linked or not. The unconstrained listing. */
export function collectKbDives(
	kbDocs: KbDoc[],
	localOnlyIds: ReadonlySet<string>,
	includeHistorical: boolean,
): ListDivesResult {
	const links = diveDocs(kbDocs).map((dive) => ({ dive }));
	return listDivesResult("kb", links, localOnlyIds, includeHistorical);
}

/** Every dive the given deck reaches, however deep in its feat tree it sits. */
export function collectDeckDives(
	deck: KbDoc,
	kbDocs: KbDoc[],
	localOnlyIds: ReadonlySet<string>,
	includeHistorical: boolean,
): ListDivesResult {
	return listDivesResult(
		`deck ${deck.name}`,
		walkDeckDives(deck, kbDocs),
		localOnlyIds,
		includeHistorical,
	);
}

export function collectListDives(
	feat: KbDoc,
	kbDocs: KbDoc[],
	localOnlyIds: ReadonlySet<string>,
	includeHistorical: boolean,
): ListDivesResult {
	const dives = diveDocs(kbDocs);
	const divesById = new Map(dives.map((doc) => [doc.id, doc]));
	const kbIds = new Set(kbDocs.map((doc) => doc.id));
	const featLabel = feat.name;

	const links: DiveLink[] = [];
	const warnings: string[] = [];
	const linkedDiveIds = new Set<string>();

	for (const link of feat.links) {
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
		if (!sameFeatRef(dive.featRef, feat)) {
			warnings.push(`dive link ${link.id} does not point back at ${featLabel}`);
			continue;
		}
		linkedDiveIds.add(dive.id);
		links.push({ dive, rel: link.rel });
	}

	// Drift/superset scan: dives that name this feat but are not linked from it.
	// A held (diver set) unlinked dive is a workon-safety hazard, so warn; the
	// full progression view (--include-historical) also lists them.
	for (const dive of dives) {
		if (linkedDiveIds.has(dive.id)) continue;
		if (!sameFeatRef(dive.featRef, feat)) continue;
		if (diveDiver(dive)) {
			warnings.push(`held dive ${dive.id} points at ${featLabel} but is not linked from the feat`);
		}
		links.push({ dive });
	}

	return listDivesResult(`feat ${featLabel}`, links, localOnlyIds, includeHistorical, warnings);
}

/**
 * A markdown link rather than a bare id: the path is ctrl-clickable from a
 * terminal, and anyone reading the output later can follow it to the scopes and
 * brief this line deliberately does not restate.
 *
 * The feat is not on this line, and is not inferred from the dive name either.
 * A managed name carries the feat's slug, but a slug is not an id and a
 * hand-named dive carries nothing at all, so a reader who needs the feat gets
 * it from the `Scope:` line this listing opens with.
 */
export function formatListedDive(dive: ListedDive): string {
	const rel = dive.rel ? ` rel=${dive.rel}` : "";
	const diver = dive.diver ? ` diver=${dive.diver}` : "";
	const needs = dive.tags.filter((tag) => tag.startsWith("needs-"));
	const states = dive.tags.filter((tag) => !tag.startsWith("needs-"));
	const needsPart =
		needs.length > 0 ? ` needs=${needs.map((tag) => tag.slice("needs-".length)).join(",")}` : "";
	const statePart = states.length > 0 ? ` ${states.join(" ")}` : "";
	const lastLog = formatLastLog(dive.lastLog);
	const lastLogPart = lastLog ? ` ${lastLog}` : "";
	const gist = dive.gist ? ` - ${dive.gist}` : "";
	return `  - [${dive.name}](${dive.source})${rel}${diver}${needsPart}${statePart}${lastLogPart}${gist}`;
}

export function appendDiveSection(lines: string[], label: string, dives: ListedDive[]): void {
	lines.push(`${label}:`);
	if (dives.length === 0) {
		lines.push("  (none)");
		return;
	}
	for (const dive of dives) lines.push(formatListedDive(dive));
}

/**
 * Feats in the order the walk first reached them, dives in the order they were
 * found under each. A dive no feat owns still gets a group, trailing the rest:
 * a caller that hands one over has decided it is worth printing, and dropping
 * it silently here would make that decision twice, in the wrong place.
 */
export function groupDivesByFeat(dives: ListedDive[]): FeatDiveGroup[] {
	const groups: FeatDiveGroup[] = [];
	const byFeat = new Map<string, FeatDiveGroup>();
	const unowned: FeatDiveGroup = { dives: [] };

	for (const dive of dives) {
		if (!dive.feat) {
			unowned.dives.push(dive);
			continue;
		}
		let group = byFeat.get(dive.feat.source);
		if (!group) {
			group = { feat: dive.feat, dives: [] };
			byFeat.set(dive.feat.source, group);
			groups.push(group);
		}
		group.dives.push(dive);
	}

	if (unowned.dives.length > 0) groups.push(unowned);
	return groups;
}

/**
 * A dive line that can be copied straight into `jump`: the doc path comes
 * first because the path is the argument, and the gist follows because that is
 * what the reader is choosing between. Nothing else on the line is
 * addressable, which is the point -- a name and an id on one line left readers
 * guessing which of the two `jump` wanted.
 *
 * `notes` is for a listing whose dives are not all equally takeable: it names
 * the holder and what the dive still lacks. `jump` lists only dives it has
 * already decided this pilot can take, so it leaves them off.
 */
export function formatJumpableDive(dive: ListedDive, notes = false): string {
	const gist = dive.gist.trim() ? `: ${dive.gist.trim()}` : "";
	const line = `- ${dive.source}${gist}`;
	if (!notes) return line;
	const needs = dive.tags.filter((tag) => tag.startsWith("needs-"));
	const states = dive.tags.filter((tag) => !tag.startsWith("needs-"));
	const lastLog = formatLastLog(dive.lastLog);
	const parts = [
		...(dive.diver ? [`diver=${dive.diver}`] : []),
		...(needs.length > 0
			? [`needs=${needs.map((tag) => tag.slice("needs-".length)).join(",")}`]
			: []),
		...states,
		...(lastLog ? [lastLog] : []),
	];
	return parts.length > 0 ? `${line} -- ${parts.join(" ")}` : line;
}

/**
 * The choose-what-to-jump listing: a heading per feat, then that feat's dives
 * as paths. Preflight and a bare `jump` both print it from here, so the
 * session report and the refusal cannot describe the same choice two ways.
 */
export function appendJumpableDives(lines: string[], dives: ListedDive[], notes = false): void {
	for (const group of groupDivesByFeat(dives)) {
		if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
		// The feat's own slug, not its dotted lineage: the parent is one link
		// away for a reader who wants it, and repeating it on every heading buys
		// nothing but width.
		lines.push(
			group.feat
				? `## [${titleFromSlug(group.feat.name.split(".")[0]!)}](${group.feat.source})`
				: "## Free dives",
		);
		lines.push("");
		for (const dive of group.dives) lines.push(formatJumpableDive(dive, notes));
	}
}

export function formatListDivesResult(result: ListDivesResult, includeHistorical: boolean): string {
	const lines = [`Scope: ${result.scope}`];
	appendDiveSection(lines, "Pending", result.pending);
	appendDiveSection(lines, "Working", result.working);
	if (includeHistorical) appendDiveSection(lines, "Historical", result.historical);
	if (result.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of result.warnings) lines.push(`  - ${warning}`);
	}
	return lines.join("\n");
}
