import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { formatPath, MarkdownDoc, NosediveRc, parseMarkdownDoc } from "./coreParsing.js";
import { KbDoc } from "./kbDocs.js";
import { uuidLike } from "./repoWorkspaceCore.js";
import {
	BacklogKbDisplayNode,
	BacklogKbEffort,
	appendBacklogKbEffortLine,
	effortHasParentLink,
	insertBacklogKbEffort,
	loadBacklogKbEfforts,
	posixRelPath,
	sortedBacklogKbChildren,
} from "./packageBacklog.js";
import { quoteYamlString } from "./renderPlan.js";

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
