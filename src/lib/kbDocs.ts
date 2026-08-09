import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

import { assertSlug, titleFromSlug } from "./backlogDives.js";
import { DIVE_BRIEF_HEADING_PATTERN } from "./constants.js";
import { TIMESTAMPED_SECTION_HEADING_PATTERN } from "./kbSections.js";
import {
	formatPath,
	NosediveRc,
	parseMarkdownDoc,
	parseMarkdownFrontmatter,
	parseYamlBlock,
	readNosediveRc,
	resolveFrom,
	splitMarkdownFrontmatter,
	toPosixPath,
} from "./coreParsing.js";
import { gitRelPath } from "./gitState.js";
import { parseLinkRefs, parseScopeRefs } from "./kbRefs.js";
import { gitOutput, quoteYamlString } from "./renderPlan.js";
import { uuid7AtMs } from "./uuid7.js";

// --- pitch -----------------------------------------------------------------

export interface PitchOptions {
	gist: string;
	name?: string;
	parent?: string;
}

function pitchOptionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parsePitchArgs(args: string[]): PitchOptions {
	let gist: string | undefined;
	let name: string | undefined;
	let parent: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--name" || arg === "--parent") {
			const value = pitchOptionValue(args, i + 1, arg);
			if (arg === "--name") name = value;
			else parent = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--name=")) {
			name = arg.slice("--name=".length);
			if (!name) throw new Error("--name requires a value");
			continue;
		}
		if (arg.startsWith("--parent=")) {
			parent = arg.slice("--parent=".length);
			if (!parent) throw new Error("--parent requires a value");
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown pitch option: ${arg}`);
		if (gist !== undefined) throw new Error(`unexpected pitch argument: ${arg}`);
		gist = arg;
	}

	if (gist === undefined) throw new Error("pitch requires a gist");
	const trimmed = gist.trim();
	if (!trimmed) throw new Error("gist cannot be empty");
	if (name !== undefined) assertSlug(name, "pitch name");
	return { gist: trimmed, name, parent };
}

/**
 * An unnamed effort still needs a stable slug, and the pitch time is the only
 * thing that distinguishes it. Seconds resolution is enough: two pitches in
 * the same second would collide on name, and the duplicate check catches that.
 */
export function defaultEffortName(now = new Date()): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return [
		"new-effort",
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
	].join("-");
}

export function renderPitchedEffort(options: {
	id: string;
	name: string;
	gist: string;
	parentId?: string;
}): string {
	const leaf = options.name.split(".")[0]!;
	const lines = [
		"---",
		"kind: feat",
		`id: ${options.id}`,
		`name: ${options.name}`,
		`gist: ${quoteYamlString(options.gist)}`,
	];
	if (options.parentId) {
		lines.push("links:", `  - kb/${options.parentId}.md:`, "      rel: parent");
	}
	lines.push("---", "", `# ${titleFromSlug(leaf)}`, "");
	return lines.join("\n");
}

export function mintEffortId(): string {
	return uuid7AtMs(Date.now());
}

// --- apply -----------------------------------------------------------------

export interface BridgeConfig {
	bridgeDir: string;
	workspaceDir?: string;
	backlogDir?: string;
	kbDir: string;
	homeBranch?: string;
	workBranchPrefix?: string;
	pilotName?: string;
	pilotEmail?: string;
	effortPath?: string;
	effortRef?: string;
	activeDiveId?: string;
}

export interface EffortRepo {
	id: string;
	ref?: string;
	readOnly: boolean;
}

export interface KbDoc {
	path: string;
	relPath: string;
	id: string;
	name: string;
	kind: string;
	gist: string;
	repoPath?: string;
	repoBaseBranch?: string;
	effortRef?: string;
	/** Body facts, kept as booleans so the body itself never has to be carried. */
	hasBrief: boolean;
	hasLog: boolean;
	metaScalars: Record<string, string>;
	metaLists: Record<string, string[]>;
	metaRaw: Record<string, unknown>;
	scopes: ScopeRef[];
	links: LinkRef[];
}

export interface ScopeRef {
	repoId: string;
	path: string;
	ref?: string;
	readOnly: boolean;
	flags: string[];
	render?: "body" | "gist";
}

export interface LinkRef {
	id: string;
	target: string;
	rel?: string;
	anchor?: string;
	/** Every scalar key written on the link, `rel`/`anchor` included. Open set: the reading command validates what it needs. */
	attrs: Record<string, string>;
}

export interface TargetDoc {
	doc: KbDoc;
	repoId: string;
	render: "body" | "gist";
	scopePath: string;
	readOnly: boolean;
}

export interface GeneratedFrontmatter {
	effort?: string;
	repoId?: string;
	scopePath?: string;
}

export interface ApplyPlan {
	bridge: BridgeConfig;
	repos: Array<EffortRepo & { repoPath?: string; repoBaseBranch: string; repoRef: string }>;
	agentFiles: string[];
	tags: Set<string>;
	targets: Map<string, TargetDoc[]>;
	warnings: string[];
}

export function parseEffortRepos(path: string): EffortRepo[] {
	const label = formatPath(path);
	const doc = parseMarkdownDoc(readFileSync(path, "utf8"), label);
	return (doc.fm.lists.repos ?? []).map((rawEntry) => {
		const entry = rawEntry.trim();
		if (!entry) throw new Error(`invalid effort repo entry in ${label}: empty value`);

		const firstColon = entry.indexOf(":");
		const secondColon = firstColon === -1 ? -1 : entry.indexOf(":", firstColon + 1);
		if (secondColon !== -1) {
			throw new Error(
				`invalid effort repo entry in ${label}: ${entry} (expected <repo-id>[@ref][:flags])`,
			);
		}

		const base = firstColon === -1 ? entry : entry.slice(0, firstColon);
		const flagText = firstColon === -1 ? "" : entry.slice(firstColon + 1);
		if (!base) throw new Error(`invalid effort repo entry in ${label}: ${entry} (missing repo id)`);

		let readOnly = false;
		if (firstColon !== -1) {
			if (!flagText)
				throw new Error(`invalid effort repo entry in ${label}: ${entry} (missing flags after :)`);
			for (const flag of flagText.split(",").map((item) => item.trim())) {
				if (!flag) throw new Error(`invalid effort repo entry in ${label}: ${entry} (empty flag)`);
				if (flag === "ro") {
					readOnly = true;
					continue;
				}
				throw new Error(
					`invalid effort repo flag in ${label}: ${entry} (unsupported flag: ${flag})`,
				);
			}
		}

		const at = base.indexOf("@");
		const secondAt = at === -1 ? -1 : base.indexOf("@", at + 1);
		if (secondAt !== -1) {
			throw new Error(
				`invalid effort repo entry in ${label}: ${entry} (expected at most one @ref)`,
			);
		}

		const id = at === -1 ? base : base.slice(0, at);
		const ref = at === -1 ? undefined : base.slice(at + 1);
		if (!id) throw new Error(`invalid effort repo entry in ${label}: ${entry} (missing repo id)`);
		if (at !== -1 && !ref)
			throw new Error(`invalid effort repo entry in ${label}: ${entry} (missing ref after @)`);

		return { id, ref, readOnly };
	});
}

/**
 * A kb doc travels between machines, so a path a Windows pilot wrote has to
 * resolve for a Linux one. Separators in kb paths are therefore a kb
 * convention rather than a platform fact: left as backslashes, the whole path
 * is one literal filename on POSIX, and a repo pinned inside the workspace
 * resolves outside it.
 */
function kbMetaPath(path: string | undefined): string | undefined {
	return path === undefined ? undefined : toPosixPath(path);
}

export function readKbDoc(path: string, bridgeDir: string): KbDoc {
	const label = formatPath(path);
	const text = readFileSync(path, "utf8");
	const fm = parseMarkdownFrontmatter(text, label);
	const raw = fm.raw;
	return {
		path,
		relPath: toPosixPath(relative(bridgeDir, path)),
		id: fm.scalars.id,
		name: fm.scalars.name,
		kind: fm.scalars.kind,
		// A doc with no `gist:` has no gist, not the four-character string
		// `undefined`: the field is typed as present, so every reader would
		// otherwise have to guard a value the type says cannot happen.
		gist: fm.scalars.gist ?? "",
		hasBrief: DIVE_BRIEF_HEADING_PATTERN.test(text),
		hasLog: TIMESTAMPED_SECTION_HEADING_PATTERN.test(text),
		repoPath: kbMetaPath(fm.nested.meta?.path),
		repoBaseBranch:
			fm.nested.meta?.trunk ??
			fm.nested.meta?.["base-branch"] ??
			fm.nested.meta?.["default-branch"],
		effortRef: fm.scalars.effort ?? fm.nested.meta?.effort,
		metaScalars: fm.nested.meta ?? {},
		metaLists: fm.nestedLists.meta ?? {},
		metaRaw:
			raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
				? (raw.meta as Record<string, unknown>)
				: {},
		scopes: parseScopeRefs(raw.scopes, path),
		links: parseLinkRefs(raw.links, path),
	};
}

export function loadKbDocs(kbDir: string, bridgeDir: string): KbDoc[] {
	return readdirSync(kbDir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => readKbDoc(join(kbDir, e.name), bridgeDir));
}

export function parseRawFrontmatterObject(text: string, label: string): Record<string, unknown> {
	if (!text.startsWith("---")) return {};
	const block = splitMarkdownFrontmatter(text, label);
	let value: unknown;
	try {
		value = parseYaml(block.yaml);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`invalid YAML in frontmatter in ${label}: ${detail}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

export function readActiveDiveId(workspaceDir: string | undefined): string | undefined {
	if (!workspaceDir) return undefined;
	const markerPath = join(workspaceDir, ".nosedive-ref");
	if (!existsSync(markerPath)) return undefined;
	const marker = parseYamlBlock(readFileSync(markerPath, "utf8"), formatPath(markerPath));
	return marker.scalars.id;
}

export function isWorkspaceEmpty(workspaceDir: string | undefined): boolean {
	if (!workspaceDir || !existsSync(workspaceDir)) return true;
	if (!statSync(workspaceDir).isDirectory()) return false;
	return readdirSync(workspaceDir).filter((entry) => entry !== ".nosedive-ref").length === 0;
}

export function isPathIgnoredByGitStatus(repoRoot: string, path: string): boolean {
	const rel = gitRelPath(repoRoot, path);
	if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
	const status = gitOutput(repoRoot, ["status", "--ignored", "--short", "--", rel]);
	return Boolean(status?.split(/\r?\n/).some((line) => line.startsWith("!! ")));
}

export function computeApplyTags(bridge: BridgeConfig): Set<string> {
	const tags = new Set<string>();
	if (isWorkspaceEmpty(bridge.workspaceDir)) tags.add("workspace-is-empty");
	if (bridge.pilotName?.trim() || bridge.pilotEmail?.trim()) tags.add("pilot-is-set");
	if (bridge.backlogDir && !existsSync(bridge.backlogDir)) tags.add("backlog-is-missing");
	if (bridge.backlogDir && isPathIgnoredByGitStatus(bridge.bridgeDir, bridge.backlogDir))
		tags.add("backlog-is-ignored");
	return tags;
}

export interface AddRepoOptions {
	repoRef: string;
	effortRef?: string;
	repoEntryRef?: string;
	readOnly: boolean;
	apply: boolean;
}

export interface AddRepoEffortScopeOptions {
	repoRef: string;
	repoEntryRef?: string;
	readOnly: boolean;
}

export function parseAddRepoArgs(args: string[]): AddRepoOptions {
	let repoRef: string | undefined;
	let effortRef: string | undefined;
	let repoEntryRef: string | undefined;
	let readOnly = false;
	let shouldApply = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--effort" || arg === "--ref") {
			const value = args[i + 1];
			if (!value) throw new Error(`${arg} requires a value`);
			if (arg === "--effort") effortRef = value;
			if (arg === "--ref") repoEntryRef = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--effort=")) {
			effortRef = arg.slice("--effort=".length);
			if (!effortRef) throw new Error("--effort requires a value");
			continue;
		}
		if (arg.startsWith("--ref=")) {
			repoEntryRef = arg.slice("--ref=".length);
			if (!repoEntryRef) throw new Error("--ref requires a value");
			continue;
		}
		if (arg === "--read-only" || arg === "--ro") {
			readOnly = true;
			continue;
		}
		if (arg === "--no-apply") {
			shouldApply = false;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown add-repo option: ${arg}`);
		if (repoRef) throw new Error(`unexpected add-repo argument: ${arg}`);
		repoRef = arg;
	}

	if (!repoRef) throw new Error("add-repo requires a repo id or name");
	if (repoEntryRef?.includes(":")) throw new Error(`repo ref cannot contain ':': ${repoEntryRef}`);
	return { repoRef, effortRef, repoEntryRef, readOnly, apply: shouldApply };
}

export function parseAddRepoEffortScopeArgs(args: string[]): AddRepoEffortScopeOptions {
	let repoRef: string | undefined;
	let repoEntryRef: string | undefined;
	let readOnly = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--ref") {
			const value = args[i + 1];
			if (!value) throw new Error("--ref requires a value");
			repoEntryRef = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--ref=")) {
			repoEntryRef = arg.slice("--ref=".length);
			if (!repoEntryRef) throw new Error("--ref requires a value");
			continue;
		}
		if (arg === "--read-only" || arg === "--ro") {
			readOnly = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown add-repo.effort option: ${arg}`);
		if (repoRef) throw new Error(`unexpected add-repo.effort argument: ${arg}`);
		repoRef = arg;
	}

	if (!repoRef) throw new Error("add-repo.effort requires a repo id or name");
	if (repoEntryRef?.includes(":")) throw new Error(`repo ref cannot contain ':': ${repoEntryRef}`);
	return { repoRef, repoEntryRef, readOnly };
}

export function repoDocs(kbDocs: KbDoc[]): KbDoc[] {
	return kbDocs.filter((doc) => doc.kind === "repo");
}
