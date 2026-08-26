import { relative } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import { toPosixPath } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { KbDoc } from "./kbDocs.js";
import { printCommandHelp } from "./packageBacklog.js";
import { slugFromGist } from "./slugs.js";

const ROLES = new Set(["dive", "feat", "gate", "repo", "note"]);
const BACKLOG_FEAT_RELS = new Set(["parent", "child"]);

/** Keep the traversal aligned with list-dives: only feat edges expand the deck. */
function isBacklogFeatRel(rel: string | undefined): boolean {
	return Boolean(
		rel && (BACKLOG_FEAT_RELS.has(rel) || rel.endsWith("-effort") || rel.endsWith(".feat")),
	);
}

export interface FindOptions {
	role?: string;
	term?: string;
	ageMs?: number;
	help: boolean;
}

export function parseFindArgs(args: string[], io: CommandIo): FindOptions {
	let ageMs: number | undefined;
	const positional: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "-h" || arg === "--help") {
			printCommandHelp("find", io);
			return { help: true };
		}
		if (arg === "--age") {
			const value = args[++index];
			if (!value) throw new Error("find --age requires a duration such as 5m, 2h, or 7d");
			const match = /^([1-9][0-9]*)([mhd])$/.exec(value);
			if (!match) throw new Error(`invalid find age: ${value} (expected 5m, 2h, or 7d)`);
			ageMs =
				Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
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
	return { role, term, ageMs, help: false };
}

function createdAt(bridgeDir: string, doc: KbDoc): number {
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
	if (!output) throw new Error(`could not resolve creation history for ${doc.relPath}`);
	const value = Number(output?.split(/\r?\n/)[0]);
	if (!Number.isFinite(value))
		throw new Error(`could not resolve creation history for ${doc.relPath}`);
	return value * 1000;
}

export function findDocs(
	root: KbDoc,
	docs: KbDoc[],
	role: string,
	term: string | undefined,
	bridgeDir: string,
	ageMs?: number,
): KbDoc[] {
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const visited = new Set<string>();
	const selected = new Set<string>();
	const queue = [root];
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
				doc.name === normalized ||
				slugFromGist(doc.gist, Number.MAX_SAFE_INTEGER) === normalized,
		)
		.filter((doc) => ageMs === undefined || Date.now() - createdAt(bridgeDir, doc) >= ageMs)
		.sort((left, right) => left.relPath.localeCompare(right.relPath));
}
