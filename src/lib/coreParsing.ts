import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument, parse as parseYaml, type ToStringOptions } from "yaml";
import {
	BASE_CONFIG_FILENAME,
	DEFAULT_RC,
	LEGACY_CONFIG_FILENAME,
	SPLIT_CONFIG_DIRNAME,
} from "./constants.js";
export {
	BASE_CONFIG_FILENAME,
	BASE_CONFIG_KNOWN_KEYS,
	CONFIG_EXCLUDE_BEGIN,
	CONFIG_EXCLUDE_END,
	CURRENT_COMPATIBILITY_LEVEL,
	DEFAULT_RC,
	FOUNDATION_EXCLUDE_BEGIN,
	FOUNDATION_EXCLUDE_END,
	GIT_LOCAL_ENV_KEYS,
	HANDOFF_RUNBOOK_ID,
	LEGACY_CONFIG_FILENAME,
	MANAGED_EXCLUDE_BEGIN,
	MANAGED_EXCLUDE_END,
	MANUAL_PRE_PUSH_LINE,
	MIGRATION_BACKUP_DIRNAME,
	PRE_PUSH_HOOK,
	REPO_MARKER_EXCLUDE_BEGIN,
	REPO_MARKER_EXCLUDE_END,
	SPLIT_CONFIG_DIRNAME,
	USAGE_HEADER,
} from "./constants.js";

import { writeFileAtomic } from "./renderPlan.js";

export const YAML_STRINGIFY_OPTIONS = {
	collectionStyle: "block",
	lineWidth: 0,
} as const satisfies ToStringOptions;

export function stringifyYaml(doc: { toString(options?: ToStringOptions): string }): string {
	return doc.toString(YAML_STRINGIFY_OPTIONS);
}

// --- bridge config shape -----------------------------------------------

// --- frontmatter -----------------------------------------------------------

export interface SimpleYaml {
	raw: Record<string, unknown>;
	scalars: Record<string, string>;
	lists: Record<string, string[]>;
	nested: Record<string, Record<string, string>>;
	nestedLists: Record<string, Record<string, string[]>>;
}

export interface MarkdownDoc {
	fm: SimpleYaml;
	body: string;
}

export interface MarkdownFrontmatterBlock {
	yaml: string;
	body: string;
}

export interface NosediveRc {
	path: string;
	bridgeDir: string;
	compatibilityLevel?: number;
	workspaceDir?: string;
	backlog?: string;
	kbDir?: string;
	homeBranch?: string;
	workBranchPrefix?: string;
	pilotName?: string;
	pilotEmail?: string;
	/** `agent-runner`: id of the memo whose `meta.cold-start-usage` runs an agent. */
	agentRunner?: string;
	/** `agent-effort-<n>`: the model a command escalating to effort `<n>` runs on. */
	agentEfforts: Record<number, string>;
	/** `<command>-prompt`: id of the `kind: idea` doc a command builds its prompt from. */
	prompts: Record<string, string>;
}

const AGENT_EFFORT_KEY = /^agent-effort-([0-9]+)$/;
const COMMAND_PROMPT_KEY = /^(.+)-prompt$/;

export function parseAgentEfforts(scalars: Record<string, string>): Record<number, string> {
	const efforts: Record<number, string> = {};
	for (const [key, value] of Object.entries(scalars)) {
		const effort = AGENT_EFFORT_KEY.exec(key);
		if (effort) efforts[Number.parseInt(effort[1]!, 10)] = value;
	}
	return efforts;
}

export function parseCommandPrompts(scalars: Record<string, string>): Record<string, string> {
	const prompts: Record<string, string> = {};
	for (const [key, value] of Object.entries(scalars)) {
		const prompt = COMMAND_PROMPT_KEY.exec(key);
		if (prompt) prompts[prompt[1]!] = value;
	}
	return prompts;
}

export function emptyYaml(): SimpleYaml {
	return { raw: {}, scalars: {}, lists: {}, nested: {}, nestedLists: {} };
}

export function scalarToString(value: unknown): string | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "object") return undefined;
	return String(value);
}

/** Normalize valid YAML into the small shape nosedive callers consume. */
export function normalizeYaml(value: unknown): SimpleYaml {
	const out = emptyYaml();
	if (!value || typeof value !== "object" || Array.isArray(value)) return out;
	out.raw = value as Record<string, unknown>;

	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (Array.isArray(item)) {
			out.lists[key] = item
				.map((entry) => scalarToString(entry))
				.filter((entry): entry is string => entry !== undefined);
			continue;
		}

		if (item && typeof item === "object") {
			const nested: Record<string, string> = {};
			const nestedLists: Record<string, string[]> = {};
			for (const [nestedKey, nestedItem] of Object.entries(item as Record<string, unknown>)) {
				if (Array.isArray(nestedItem)) {
					nestedLists[nestedKey] = nestedItem
						.map((entry) => scalarToString(entry))
						.filter((entry): entry is string => entry !== undefined);
					continue;
				}
				const scalar = scalarToString(nestedItem);
				if (scalar !== undefined) nested[nestedKey] = scalar;
			}
			out.nested[key] = nested;
			out.nestedLists[key] = nestedLists;
			continue;
		}

		const scalar = scalarToString(item);
		if (scalar !== undefined) out.scalars[key] = scalar;
	}

	return out;
}

export function parseYamlBlock(block: string, label: string): SimpleYaml {
	try {
		return normalizeYaml(parseYaml(block));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`invalid YAML in ${label}: ${detail}`);
	}
}

export function leadingMarkdownFrontmatter(text: string): MarkdownFrontmatterBlock | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	return match
		? {
				yaml: match[1] ?? "",
				body: text.slice(match[0].length),
			}
		: undefined;
}

/** Parse leading `---` YAML frontmatter and return the body separately. */
export function parseMarkdownDoc(text: string, label = "markdown frontmatter"): MarkdownDoc {
	const block = leadingMarkdownFrontmatter(text);
	if (!block) return { fm: emptyYaml(), body: text };
	return {
		fm: parseYamlBlock(block.yaml, `frontmatter in ${label}`),
		body: block.body,
	};
}

export function splitMarkdownFrontmatter(
	text: string,
	label = "markdown document",
): MarkdownFrontmatterBlock {
	if (!text.startsWith("---")) throw new Error(`${label} is missing YAML frontmatter`);
	const block = leadingMarkdownFrontmatter(text);
	if (!block) throw new Error(`${label} has unterminated YAML frontmatter`);
	return block;
}

/** Parse only leading `---` YAML frontmatter. */
export function parseMarkdownFrontmatter(text: string, label = "markdown document"): SimpleYaml {
	const block = leadingMarkdownFrontmatter(text);
	return block ? parseYamlBlock(block.yaml, `frontmatter in ${label}`) : emptyYaml();
}

/** Parse leading `---` YAML frontmatter into a flat string map. */
export function parseFrontmatter(
	text: string,
	label = "markdown frontmatter",
): Record<string, string> {
	return parseMarkdownDoc(text, label).fm.scalars;
}

export function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "...";
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

export function resolveFrom(base: string, path: string): string {
	const expanded = expandHome(path);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function formatPath(path: string): string {
	const rel = relative(process.cwd(), path);
	const rendered = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
	return toPosixPath(rendered || ".");
}

/** Render a path with forward slashes, even on Windows. */
export function toPosixPath(path: string): string {
	return path.replaceAll("\\", "/");
}

export function baseConfigPath(bridgeDir: string): string {
	return join(bridgeDir, SPLIT_CONFIG_DIRNAME, BASE_CONFIG_FILENAME);
}

export function legacyConfigPath(bridgeDir: string): string {
	return join(bridgeDir, LEGACY_CONFIG_FILENAME);
}

export type ResolvedBridgeConfig =
	| { shape: "split"; bridgeDir: string; basePath: string }
	| { shape: "legacy"; bridgeDir: string; legacyPath: string };

/**
 * Walk upward from `start` looking for bridge config. Split-shape
 * (`.nosedive/config.yaml`) takes priority over legacy (`.nosediverc`) at
 * each directory, so a bridge mid-migration can't be shadowed by a stale
 * legacy file left one level up.
 */
export function findBridgeConfig(start: string): ResolvedBridgeConfig | undefined {
	let dir = resolve(start);
	for (;;) {
		const basePath = baseConfigPath(dir);
		if (existsSync(basePath)) return { shape: "split", bridgeDir: dir, basePath };
		const legacyPath = legacyConfigPath(dir);
		if (existsSync(legacyPath)) return { shape: "legacy", bridgeDir: dir, legacyPath };
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function noBridgeConfigError(): Error {
	return new Error(
		`not inside a nosedive bridge: no ${SPLIT_CONFIG_DIRNAME}/${BASE_CONFIG_FILENAME} or ${LEGACY_CONFIG_FILENAME} found`,
	);
}

export function configCompatibilityLevel(config: SimpleYaml, label: string): number {
	const raw = config.scalars["compatibility-level"];
	const level = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isInteger(level) || level < 0) {
		throw new Error(`${formatPath(label)} has no readable compatibility-level`);
	}
	return level;
}

export function readNosediveRc(start: string): NosediveRc {
	const resolved = findBridgeConfig(start);
	if (!resolved) throw noBridgeConfigError();

	const bridgeDir = resolved.bridgeDir;
	const rc =
		resolved.shape === "split"
			? parseYamlBlock(readFileSync(resolved.basePath, "utf8"), formatPath(resolved.basePath))
			: parseYamlBlock(readFileSync(resolved.legacyPath, "utf8"), formatPath(resolved.legacyPath));
	const workspace = rc.scalars.workspace;
	const backlog = rc.scalars.backlog;
	const kb = rc.scalars.kb;

	return {
		path: resolved.shape === "split" ? resolved.basePath : resolved.legacyPath,
		bridgeDir,
		compatibilityLevel:
			resolved.shape === "split" ? configCompatibilityLevel(rc, resolved.basePath) : 0,
		workspaceDir: workspace ? resolveFrom(bridgeDir, workspace) : undefined,
		backlog,
		kbDir: kb ? resolveFrom(bridgeDir, kb) : undefined,
		homeBranch: rc.scalars["home-branch"],
		workBranchPrefix: rc.scalars["work-branch-prefix"],
		pilotName: rc.scalars["pilot-name"],
		pilotEmail: rc.scalars["pilot-email"],
		agentRunner: rc.scalars["agent-runner"],
		agentEfforts: parseAgentEfforts(rc.scalars),
		prompts: parseCommandPrompts(rc.scalars),
	};
}

// --- seed --------------------------------------------------------------

export interface RcSettings {
	workspace: string;
	backlog: string;
	kb: string;
	homeBranch: string;
	workBranchPrefix: string;
	pilotName: string;
	pilotEmail: string;
	/**
	 * Config keys nosedive does not own, kept verbatim so a re-seed cannot
	 * silently delete a pilot's `agent-effort-<n>`, `agent-runner` or
	 * `<command>-prompt` settings. Seed rewrites the whole file; anything it
	 * does not carry across is gone.
	 */
	extra: Record<string, string>;
}

export interface SeedOptions {
	help: boolean;
	headless: boolean;
	/** Agent instruction files named with `--file`; empty means autodetect. */
	files: string[];
}
