import { existsSync, mkdirSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pascalFromSlug, titleFromSlug } from "./backlogDives.js";
import { CommandIo, Migration } from "./bridgeSetupIo.js";
import { BRIDGE_STATE_DIRNAME, MIGRATION_BACKUP_DIRNAME, shellQuote } from "./constants.js";
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
	toPosixPath,
	truncate,
} from "./coreParsing.js";
import { KbDoc } from "./kbDocs.js";
import { unsafeLinkPath } from "./proveCore.js";
import { writeFileAtomic } from "./renderPlan.js";
import { uuidLike } from "./repoWorkspaceCore.js";

const LOCAL_DEV_VERSION = "0.0.0-dev";

export function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Renders the reproducible invocation for one package version and root. */
export function nosediveInvocationFor(version: string, root: string): string {
	if (version !== LOCAL_DEV_VERSION) return `npx -y nosedive@${version}`;
	return `node ${shellQuote(toPosixPath(join(root, "dist", "cli.js")))}`;
}

/** A reproducible invocation of the package version currently running. */
export function nosediveInvocation(): string {
	return nosediveInvocationFor(nosedivePackageVersion(), packageRoot());
}

/** The version of the package executing this command. */
export function nosedivePackageVersion(): string {
	const root = packageRoot();
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		version: string;
	};
	return version;
}

export function packageDocsOfKind(kind: string): Array<{ filename: string; content: string }> {
	const kbDir = join(packageRoot(), "kb");
	if (!existsSync(kbDir)) return [];

	return readdirSync(kbDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => {
			const sourcePath = join(kbDir, entry.name);
			const content = readFileSync(sourcePath, "utf8");
			const fm = parseMarkdownFrontmatter(content, formatPath(sourcePath));
			return fm.scalars.kind === kind ? { filename: entry.name, content } : undefined;
		})
		.filter((doc): doc is { filename: string; content: string } => doc !== undefined);
}
export function packageMigrationDocs(): Array<{ filename: string; content: string }> {
	return packageDocsOfKind("migration");
}

export function bridgeCompatibilityLevel(start: string): number | undefined {
	const resolved = findBridgeConfig(start);
	if (!resolved) return undefined;
	if (resolved.shape === "legacy") return 0;
	const base = parseYamlBlock(
		readFileSync(resolved.basePath, "utf8"),
		formatPath(resolved.basePath),
	);
	return configCompatibilityLevel(base, resolved.basePath);
}

/** The level of the bridge under `start`, or undefined if none is readable. */
export function maybeBridgeCompatibilityLevel(start: string): number | undefined {
	try {
		return bridgeCompatibilityLevel(start);
	} catch {
		return undefined;
	}
}

/**
 * An explicit `<command>@<N>` may outrun the bridge it is pointed at, because
 * that is how a level gets exercised before any bridge has migrated to it. Say
 * so out loud so nobody mistakes the escape hatch for a supported route.
 */
export function aheadOfBridgeWarning(
	command: string,
	level: number,
	bridgeLevel: number | undefined,
): string | undefined {
	if (bridgeLevel === undefined || level <= bridgeLevel) return undefined;
	return (
		`nosedive: warning: ${command}@${level} is ahead of this bridge (level ${bridgeLevel}); ` +
		`running a command ahead of the bridge is not an officially-supported pathway\n`
	);
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

export let topLevelHelpRenderer: ((options?: { agents?: boolean }) => string) | undefined;

export function setTopLevelHelpRenderer(render: (options?: { agents?: boolean }) => string): void {
	topLevelHelpRenderer = render;
}

/**
 * The `nosedive help` text, for commands that embed the command surface in what
 * they write. `agents` renders the agent-facing variant, which states each
 * command's `meta.agents-use-when` trigger.
 */
export function renderTopLevelHelp(options?: { agents?: boolean }): string {
	if (!topLevelHelpRenderer) throw new Error("no top-level help renderer configured");
	return topLevelHelpRenderer(options);
}
export const NOSEDIVE_DIR_GITIGNORE = ["cache/", `${MIGRATION_BACKUP_DIRNAME}/`, ""].join("\n");

/** nosedive owns ignore rules for its own state under `.nosedive/`: the git cache and migration backups are local, `config.yaml` is not. */
export function writeNosediveDirGitignore(bridgeDir: string): void {
	writeFileAtomic(join(bridgeDir, BRIDGE_STATE_DIRNAME, ".gitignore"), NOSEDIVE_DIR_GITIGNORE);
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
	const body = parseMarkdownDoc(readFileSync(doc.path, "utf8"), formatPath(doc.path)).body;
	return firstMarkdownHeading(body, titleFromSlug(leafSlug));
}

export function effortHasParentLink(doc: KbDoc): boolean {
	return doc.links.some((link) => link.rel === "parent");
}

export function loadBacklogKbEfforts(kbDocs: KbDoc[]): BacklogKbEffort[] {
	return kbDocs
		.filter((doc) => doc.kind === "feat")
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
