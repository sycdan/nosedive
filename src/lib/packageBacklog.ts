import { existsSync, mkdirSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pascalFromSlug, titleFromSlug } from "./backlogDives.js";
import { CommandIo, Migration } from "./bridgeSetupIo.js";
import { KNOWN_AGENTS, MIGRATION_BACKUP_DIRNAME, SPLIT_CONFIG_DIRNAME } from "./constants.js";
import {
	configCompatibilityLevel,
	findBridgeConfig,
	formatPath,
	parseFrontmatter,
	parseMarkdownDoc,
	parseMarkdownFrontmatter,
	parseYamlBlock,
	readNosediveRc,
	resolveFrom,
	truncate,
} from "./coreParsing.js";
import { KbDoc } from "./kbDocs.js";
import { unsafeLinkPath } from "./proveCore.js";
import { writeFileAtomic } from "./renderPlan.js";
import { uuidLike } from "./repoWorkspaceCore.js";

export async function promptAgents(io: CommandIo, current: string[]): Promise<string[]> {
	for (;;) {
		const line = await io.prompt(
			`agents, comma-separated (options: ${KNOWN_AGENTS.join(", ")}) [${current.join(",")}]: `,
		);
		if (line === undefined) return current;
		const list =
			line === ""
				? current
				: line
						.split(",")
						.map((entry) => entry.trim())
						.filter(Boolean);
		const unknown = list.filter((agent) => !KNOWN_AGENTS.includes(agent));
		if (unknown.length > 0) {
			io.err(`unknown agent(s): ${unknown.join(", ")} (options: ${KNOWN_AGENTS.join(", ")})`);
			continue;
		}
		if (list.length === 0) {
			io.err("select at least one agent");
			continue;
		}
		return list;
	}
}

export function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function packageDocsOfKind(kind: string): Array<{ filename: string; content: string }> {
	const kbDir = join(packageRoot(), "kb");
	if (!existsSync(kbDir)) return [];

	return readdirSync(kbDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => {
			const sourcePath = join(kbDir, entry.name);
			const content = readFileSync(sourcePath, "utf8");
			const fm = parseMarkdownFrontmatter(content, sourcePath);
			return fm.scalars.kind === kind ? { filename: entry.name, content } : undefined;
		})
		.filter((doc): doc is { filename: string; content: string } => doc !== undefined);
}

export function packageFoundationDocs(): Array<{ filename: string; content: string }> {
	return packageDocsOfKind("foundation");
}

export function packageMigrationDocs(): Array<{ filename: string; content: string }> {
	return packageDocsOfKind("migration");
}

export function parsePackageMigration(doc: { filename: string; content: string }): Migration {
	const path = join(packageRoot(), "kb", doc.filename);
	const parsed = parseMarkdownDoc(doc.content, path);
	const id = parsed.fm.scalars.id;
	const fromLevel = Number.parseInt(parsed.fm.nested.meta?.["from-level"] ?? "", 10);
	const toLevel = Number.parseInt(parsed.fm.nested.meta?.["to-level"] ?? "", 10);
	const scriptRelPath = parsed.fm.nested.meta?.script;
	if (!id) throw new Error(`migration ${formatPath(path)} is missing id`);
	if (!Number.isInteger(fromLevel) || fromLevel < 0) {
		throw new Error(`migration ${formatPath(path)} is missing readable meta.from-level`);
	}
	if (!Number.isInteger(toLevel) || toLevel <= fromLevel) {
		throw new Error(`migration ${formatPath(path)} is missing readable meta.to-level`);
	}
	if (
		!scriptRelPath ||
		!scriptRelPath.startsWith("kb/artifacts/") ||
		isAbsolute(scriptRelPath) ||
		unsafeLinkPath(scriptRelPath)
	) {
		throw new Error(
			`migration ${formatPath(path)} must set meta.script to a safe repo-root kb/artifacts path`,
		);
	}
	return {
		fromLevel,
		toLevel,
		docId: id,
		scriptRelPath,
		summary: parsed.fm.scalars.gist ?? "",
	};
}

export function packageMigrations(): Migration[] {
	return packageMigrationDocs()
		.map((doc) => parsePackageMigration(doc))
		.sort((a, b) => a.fromLevel - b.fromLevel);
}

export function bridgeCompatibilityLevel(start: string): number | undefined {
	const resolved = findBridgeConfig(start);
	if (!resolved) return undefined;
	if (resolved.shape === "legacy") return 0;
	const base = parseYamlBlock(readFileSync(resolved.basePath, "utf8"), resolved.basePath);
	return configCompatibilityLevel(base, resolved.basePath);
}

export let commandHelpPrinter: ((command: string, io: CommandIo) => void) | undefined;

export function setCommandHelpPrinter(print: (command: string, io: CommandIo) => void): void {
	commandHelpPrinter = print;
}

export function printCommandHelp(command: string, io: CommandIo): void {
	if (!commandHelpPrinter)
		throw new Error(`no command help printer configured for command: ${command}`);
	commandHelpPrinter(command, io);
}

export function seedPackageDocs(
	bridgeDir: string,
	kbPath: string,
	docs: Array<{ filename: string; content: string }>,
): string[] {
	if (docs.length === 0) return [];

	const kbDir = resolveFrom(bridgeDir, kbPath);
	mkdirSync(kbDir, { recursive: true });

	return docs.map((doc) => {
		const target = join(kbDir, doc.filename);
		writeFileAtomic(target, doc.content);
		return target;
	});
}

export function seedPackageFoundationDocs(bridgeDir: string, kbPath: string): string[] {
	return seedPackageDocs(bridgeDir, kbPath, packageFoundationDocs());
}

export const NOSEDIVE_DIR_GITIGNORE = ["cache/", `${MIGRATION_BACKUP_DIRNAME}/`, ""].join("\n");

/** nosedive owns ignore rules for its own state under `.nosedive/`: the git cache and migration backups are local, `config.yaml` is not. */
export function writeNosediveDirGitignore(bridgeDir: string): void {
	writeFileAtomic(join(bridgeDir, SPLIT_CONFIG_DIRNAME, ".gitignore"), NOSEDIVE_DIR_GITIGNORE);
}

// --- whoami ------------------------------------------------------------

export interface WhoamiOptions {
	help: boolean;
}

export type IdentitySource = "rc" | "git" | "unset";

export interface IdentityField {
	key: "pilot-name" | "pilot-email";
	value: string;
	source: IdentitySource;
}

export function parseWhoamiOptions(args: string[]): WhoamiOptions {
	const options: WhoamiOptions = { help: false };
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown whoami option: ${arg}`);
		throw new Error(`unexpected whoami argument: ${arg}`);
	}
	return options;
}

export function resolveIdentityField(
	key: IdentityField["key"],
	configured: string | undefined,
	detected: string,
): IdentityField {
	if (configured !== undefined) return { key, value: configured, source: "rc" };
	if (detected) return { key, value: detected, source: "git" };
	return { key, value: "<unset>", source: "unset" };
}

// --- efforts ---------------------------------------------------------------

export interface Effort {
	depth: number;
	chain: string; // slug chain, leaf-first, dot-joined
	path: string;
	phase: string;
	gist: string;
}

export interface BacklogNode {
	slug: string;
	effort?: Effort;
	children: BacklogNode[];
}

export interface BacklogConfig {
	bridgeDir: string;
	backlogDir: string;
}

export function effortMarkdownInDir(dir: string, slug: string): string | undefined {
	const expected = join(dir, `${pascalFromSlug(slug)}.md`);
	return existsSync(expected) ? expected : undefined;
}

/** Walk one backlog directory, preserving non-effort domain directories. */
export function walkBacklogNode(
	dir: string,
	slug: string,
	ancestors: string[],
): BacklogNode | undefined {
	const entries = readdirSync(dir, { withFileTypes: true });
	const path = effortMarkdownInDir(dir, slug);
	const chain = [slug, ...ancestors];
	const children = entries
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((e) => walkBacklogNode(join(dir, e.name), e.name, chain))
		.filter((node): node is BacklogNode => node !== undefined);
	let effort: Effort | undefined;

	if (path) {
		// Presence under backlog/ means open; finished work leaves for kb/.
		const text = readFileSync(path, "utf8");
		const fm = parseFrontmatter(text, path);
		effort = {
			depth: ancestors.length,
			chain: chain.join("."),
			path,
			phase: fm.phase || "unknown",
			gist: fm.gist || "",
		};
	}

	if (!effort && children.length === 0) return undefined;
	return { slug, effort, children };
}

export function collectBacklog(effortsDir: string): BacklogNode[] {
	let top: Dirent[];
	try {
		top = readdirSync(effortsDir, { withFileTypes: true });
	} catch {
		return []; // missing efforts/ dir -> empty backlog
	}
	return top
		.filter((e) => e.isDirectory() && !e.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((e) => walkBacklogNode(join(effortsDir, e.name), e.name, []))
		.filter((node): node is BacklogNode => node !== undefined);
}

export function flattenEfforts(nodes: BacklogNode[]): Effort[] {
	return nodes.flatMap((node) => [
		...(node.effort ? [node.effort] : []),
		...flattenEfforts(node.children),
	]);
}

export function collectEfforts(effortsDir: string): Effort[] {
	return flattenEfforts(collectBacklog(effortsDir));
}

export function loadBacklogConfig(start: string): BacklogConfig {
	const rc = readNosediveRc(start);

	if (!rc.backlogDir) throw new Error(".nosediverc is missing backlog");
	return { bridgeDir: rc.bridgeDir, backlogDir: rc.backlogDir };
}

export function treeChars(): { tee: string; elbow: string; pipe: string; blank: string } {
	if (process.env.NOSEDIVE_ASCII_TREE === "1") {
		return { tee: "|- ", elbow: "`- ", pipe: "|  ", blank: "   " };
	}
	return { tee: "├─ ", elbow: "└─ ", pipe: "│  ", blank: "   " };
}

export function formatBacklogNode(
	node: BacklogNode,
	prefix: string,
	last: boolean,
	verbose: boolean,
	lines: string[],
	tree = treeChars(),
): void {
	const branch = last ? tree.elbow : tree.tee;
	const childPrefix = prefix + (last ? tree.blank : tree.pipe);
	if (node.effort) {
		const phase = `[${node.effort.phase}]`;
		lines.push(`${prefix}${branch}${phase} ${node.effort.chain}`);
		if (verbose) lines.push(`${childPrefix}${node.effort.path}`);
		if (node.effort.gist) lines.push(`${childPrefix}${truncate(node.effort.gist, 72)}`);
	} else {
		lines.push(`${prefix}${branch}${node.slug}/`);
	}
	node.children.forEach((child, index) =>
		formatBacklogNode(child, childPrefix, index === node.children.length - 1, verbose, lines, tree),
	);
}

export function formatBacklog(nodes: BacklogNode[], verbose: boolean): string {
	if (nodes.length === 0) {
		return "No open efforts.";
	}

	const lines: string[] = [];
	const tree = treeChars();
	nodes.forEach((node, index) =>
		formatBacklogNode(node, "", index === nodes.length - 1, verbose, lines, tree),
	);
	return lines.join("\n");
}

export interface BacklogKbEffort {
	doc: KbDoc;
	title: string;
	segments: string[];
}

export interface BacklogKbDisplayNode {
	slug: string;
	effort?: BacklogKbEffort;
	children: Map<string, BacklogKbDisplayNode>;
}

export function firstMarkdownHeading(body: string, fallback: string): string {
	const match = /^#\s+(.+?)\s*$/m.exec(body);
	return match?.[1]?.trim() || fallback;
}

export function posixRelPath(from: string, to: string): string {
	return relative(from, to).replaceAll("\\", "/");
}

export function effortDocTitle(doc: KbDoc, leafSlug: string): string {
	const body = parseMarkdownDoc(readFileSync(doc.path, "utf8"), doc.path).body;
	return firstMarkdownHeading(body, titleFromSlug(leafSlug));
}

export function effortHasParentLink(doc: KbDoc): boolean {
	return doc.links.some((link) => link.rel === "parent");
}

export function loadBacklogKbEfforts(kbDocs: KbDoc[]): BacklogKbEffort[] {
	return kbDocs
		.filter((doc) => doc.kind === "effort")
		.map((doc) => {
			if (!doc.id) throw new Error(`effort doc is missing id: ${formatPath(doc.path)}`);
			if (!uuidLike(doc.id)) throw new Error(`effort doc id is not UUID-shaped: ${doc.id}`);
			if (!doc.name) throw new Error(`effort doc is missing name: ${formatPath(doc.path)}`);
			const leafFirst = doc.name.split(".").filter(Boolean);
			if (leafFirst.length === 0) {
				throw new Error(`effort doc name has no readable slug chain: ${formatPath(doc.path)}`);
			}
			const segments = [...leafFirst].reverse();
			return { doc, title: effortDocTitle(doc, leafFirst[0]!), segments };
		})
		.sort((a, b) => a.segments.join("/").localeCompare(b.segments.join("/")));
}

export function insertBacklogKbEffort(root: BacklogKbDisplayNode, effort: BacklogKbEffort): void {
	let node = root;
	for (const slug of effort.segments) {
		let child = node.children.get(slug);
		if (!child) {
			child = { slug, children: new Map() };
			node.children.set(slug, child);
		}
		node = child;
	}
	if (node.effort) throw new Error(`duplicate effort name in kb: ${effort.doc.name}`);
	node.effort = effort;
}

export function appendBacklogKbEffortLine(
	lines: string[],
	effort: BacklogKbEffort,
	depth = 0,
): void {
	const indent = "  ".repeat(depth);
	const gist = effort.doc.gist ? `: ${effort.doc.gist}` : "";
	lines.push(`${indent}- [${effort.title}](${basename(effort.doc.path)})${gist}`);
}

export function sortedBacklogKbChildren(node: BacklogKbDisplayNode): BacklogKbDisplayNode[] {
	return [...node.children.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}
