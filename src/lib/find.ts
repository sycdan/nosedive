import { relative } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import { toPosixPath } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { KbDoc } from "./kbDocs.js";
import { backlogDocTitle, printCommandHelp } from "./packageBacklog.js";
import { slugFromGist } from "./slugs.js";

const ROLES = new Set(["dive", "feat", "gate", "repo", "note"]);
const BACKLOG_FEAT_RELS = new Set(["parent", "child"]);
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DEFAULT_MAX_AGE_MS = UNITS.w;

/** Keep the traversal aligned with list-dives: only feat edges expand the deck. */
function isBacklogFeatRel(rel: string | undefined): boolean {
	return Boolean(
		rel && (BACKLOG_FEAT_RELS.has(rel) || rel.endsWith("-effort") || rel.endsWith(".feat")),
	);
}

function parseAge(flag: string, value: string | undefined): number {
	if (!value) throw new Error(`find ${flag} requires a duration such as 5m, 2h, 7d, or 1w`);
	const match = /^([1-9][0-9]*)([mhdw])$/.exec(value);
	if (!match) throw new Error(`invalid find age: ${value} (expected 5m, 2h, 7d, or 1w)`);
	return Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
}

export interface FindOptions {
	role?: string;
	term?: string;
	minAgeMs?: number;
	maxAgeMs?: number;
	scopes: string[];
	help: boolean;
}

export function parseFindArgs(args: string[], io: CommandIo): FindOptions {
	let minAgeMs: number | undefined;
	let maxAgeMs: number | undefined;
	const scopes: string[] = [];
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "-h" || arg === "--help") {
			printCommandHelp("find", io);
			return { help: true, scopes };
		}
		if (arg === "--min-age") {
			minAgeMs = parseAge(arg, args[++index]);
			continue;
		}
		if (arg === "--max-age") {
			maxAgeMs = parseAge(arg, args[++index]);
			continue;
		}
		if (arg === "--scope") {
			const value = args[++index];
			if (!value) throw new Error("find --scope requires a repo name or id");
			scopes.push(value);
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown find option: ${arg}`);
		positional.push(arg);
	}
	if (positional.length === 0) throw new Error("find requires <role>");
	if (positional.length > 2) throw new Error(`unexpected find argument: ${positional[2]}`);
	const [role, term] = positional;
	if (!ROLES.has(role!))
		throw new Error(`unsupported find role: ${role} (expected dive, feat, gate, repo, or note)`);
	// A window only exists if its floor is below its ceiling; the pair that
	// crosses selects nothing, and silence is a worse answer than a refusal.
	if (minAgeMs !== undefined && maxAgeMs !== undefined && minAgeMs >= maxAgeMs)
		throw new Error("find --min-age must be shorter than --max-age");
	// The default ceiling is the recent past, but only where the pilot named no
	// window at all: --min-age 2w with an unrequested 1w ceiling matches nothing.
	if (maxAgeMs === undefined && minAgeMs === undefined) maxAgeMs = DEFAULT_MAX_AGE_MS;
	return { role, term, minAgeMs, maxAgeMs, scopes, help: false };
}

/**
 * A document Git has never seen was written moments ago, so it is as new as a
 * document can be. Refusing to age it would break `note` then `find`, which is
 * the one sequence a pilot runs without thinking.
 */
function ageMs(bridgeDir: string, doc: KbDoc): number {
	const path = toPosixPath(relative(bridgeDir, doc.path));
	const output = gitOutput(bridgeDir, [
		"log",
		"--diff-filter=A",
		"--follow",
		"--format=%ct",
		"--reverse",
		"--",
		path,
	]);
	// An empty log is the untracked case, and Number("") is 0, which would date
	// the document to the epoch rather than to now.
	if (!output) return 0;
	const seconds = Number(output.split(/\r?\n/)[0]);
	if (!Number.isFinite(seconds)) return 0;
	return Date.now() - seconds * 1000;
}

/** Resolve each `--scope` to a repo id, accepting either the id or the repo's name. */
export function resolveFindScopes(docs: KbDoc[], scopes: string[]): Set<string> {
	const repos = docs.filter((doc) => doc.kind === "repo");
	return new Set(
		scopes.map((scope) => {
			const repo = repos.find((doc) => doc.id === scope || doc.name === scope);
			if (!repo) throw new Error(`unknown find scope: ${scope}`);
			return repo.id;
		}),
	);
}

export function findDocs(
	root: KbDoc,
	docs: KbDoc[],
	role: string,
	term: string | undefined,
	bridgeDir: string,
	options: { minAgeMs?: number; maxAgeMs?: number; scopeIds: Set<string> },
): KbDoc[] {
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const { scopeIds } = options;
	const visited = new Set<string>();
	const selected = new Set<string>();
	/**
	 * The backlog names its repos as scopes, not as links, so a walk that only
	 * follows links never sees the notes and gates a repo carries. Seed the
	 * queue with those repo documents as if the backlog had linked them.
	 */
	const seeded = root.scopes
		.filter((scope) => scopeIds.size === 0 || scopeIds.has(scope.repoId))
		.map((scope) => byId.get(scope.repoId))
		.filter((doc): doc is KbDoc => Boolean(doc));
	const queue = [root, ...seeded];
	while (queue.length > 0) {
		const owner = queue.shift()!;
		if (visited.has(owner.id)) continue;
		visited.add(owner.id);
		for (const link of owner.links) {
			const target = byId.get(link.id);
			if (!target) continue;
			if (link.rel?.endsWith(`.${role}`)) selected.add(target.id);
			if (target.kind !== "repo" && isBacklogFeatRel(link.rel)) queue.push(target);
		}
	}
	const normalized = term ? slugFromGist(term, Number.MAX_SAFE_INTEGER) : undefined;
	if (term && !normalized) return [];
	return [...selected]
		.map((id) => byId.get(id)!)
		.filter(
			(doc) =>
				!normalized ||
				doc.name.includes(normalized) ||
				Boolean(slugFromGist(doc.gist, Number.MAX_SAFE_INTEGER)?.includes(normalized)),
		)
		.filter((doc) => scopeIds.size === 0 || doc.scopes.some((scope) => scopeIds.has(scope.repoId)))
		.filter((doc) => {
			if (options.minAgeMs === undefined && options.maxAgeMs === undefined) return true;
			const age = ageMs(bridgeDir, doc);
			if (options.minAgeMs !== undefined && age < options.minAgeMs) return false;
			return options.maxAgeMs === undefined || age <= options.maxAgeMs;
		})
		.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

export function renderFindResults(role: string, docs: KbDoc[]): string[] {
	const heading = `${role.slice(0, 1).toUpperCase()}${role.slice(1)}s`;
	const lines = [`## ${heading}`, ""];
	if (docs.length === 0) lines.push("No matches.");
	// Same entry shape the backlog renders, for the same reason: a document is
	// known by its title, and its gist is the sentence explaining the title.
	else
		lines.push(
			...docs.map(
				(doc) => `- [${backlogDocTitle(doc)}](${doc.relPath})${doc.gist ? `: ${doc.gist}` : ""}`,
			),
		);
	return lines;
}
