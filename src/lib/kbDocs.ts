import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

import { assertSlug, effortRefFromPath, resolveEffortPath, titleFromSlug } from "./backlogDives.js";
import {
	NosediveRc,
	parseMarkdownDoc,
	parseMarkdownFrontmatter,
	parseYamlBlock,
	readNosediveRc,
	resolveFrom,
	splitMarkdownFrontmatter,
} from "./coreParsing.js";
import { gitRelPath } from "./gitState.js";
import { parseLinkRefs, parseScopeRefs } from "./proveHostRender.js";
import { gitOutput, quoteYamlString } from "./renderPlan.js";

export function parsePitchArgs(args: string[]): {
	slug: string;
	gist: string;
	pitch: string;
	parent?: string;
} {
	let slug: string | undefined;
	let pitchText: string | undefined;
	let gistText: string | undefined;
	let parent: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--parent" || arg === "--pitch" || arg === "--gist") {
			const value = args[i + 1];
			if (!value) throw new Error(`${arg} requires a value`);
			if (arg === "--parent") parent = value;
			if (arg === "--pitch") pitchText = value;
			if (arg === "--gist") gistText = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--parent=")) {
			parent = arg.slice("--parent=".length);
			if (!parent)
				throw new Error("--parent requires an effort or namespace path, or an effort slug chain");
			continue;
		}
		if (arg.startsWith("--pitch=")) {
			pitchText = arg.slice("--pitch=".length);
			if (!pitchText) throw new Error("--pitch requires a value");
			continue;
		}
		if (arg.startsWith("--gist=")) {
			gistText = arg.slice("--gist=".length);
			if (!gistText) throw new Error("--gist requires a value");
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown pitch option: ${arg}`);
		if (slug) throw new Error(`unexpected pitch argument: ${arg}`);
		slug = assertSlug(arg, "pitch slug");
	}

	if (!slug) throw new Error("pitch requires a slug");
	const defaultText = titleFromSlug(slug);
	const pitch = (pitchText ?? gistText ?? defaultText).trim();
	const gist = (gistText ?? pitchText ?? defaultText).trim();
	if (!pitch) throw new Error("pitch text cannot be empty");
	if (!gist) throw new Error("gist cannot be empty");
	return { slug, gist, pitch, parent };
}

export function renderPitchedEffort(slug: string, gist: string, pitchText: string): string {
	const title = titleFromSlug(slug);
	return [
		"---",
		"phase: framing",
		`gist: ${quoteYamlString(gist)}`,
		"---",
		"",
		`# ${title}`,
		"",
		"## Framing",
		"",
		pitchText,
		"",
	].join("\n");
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
	agents: string[];
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

export function currentDeveloperId(bridgeDir: string): string | undefined {
	return (
		gitOutput(bridgeDir, ["config", "user.email"]) || gitOutput(bridgeDir, ["config", "user.name"])
	);
}

export function heldDiveEffortRefs(rc: NosediveRc): string[] {
	if (!rc.kbDir || !rc.backlogDir) return [];
	const developer = currentDeveloperId(rc.bridgeDir);
	if (!developer) return [];

	return readdirSync(rc.kbDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => {
			const path = join(rc.kbDir!, entry.name);
			const fm = parseMarkdownFrontmatter(readFileSync(path, "utf8"), path);
			if (fm.scalars.kind !== "dive") return undefined;
			if (fm.nested.meta?.diver !== developer) return undefined;
			return fm.scalars.effort;
		})
		.filter((effort): effort is string => Boolean(effort));
}

export function activeEffortRefFromHeldDive(rc: NosediveRc): string | undefined {
	if (!rc.backlogDir) return undefined;
	const held = heldDiveEffortRefs(rc);
	if (held.length === 0) return undefined;
	if (held.length > 1) throw new Error(`developer has more than one held dive: ${held.join(", ")}`);
	return effortRefFromPath(
		resolveEffortPath(held[0]!, rc.bridgeDir, rc.backlogDir, "held dive effort"),
		rc.backlogDir,
	);
}

export function loadBridgeConfig(start: string): BridgeConfig {
	const rc = readNosediveRc(start);
	const effort = rc.current.effort ?? activeEffortRefFromHeldDive(rc);

	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!gitOutput(rc.bridgeDir, ["rev-parse", "--show-toplevel"])) {
		throw new Error("nosedive apply must be run inside a git-backed bridge");
	}

	const bridge: BridgeConfig = {
		bridgeDir: rc.bridgeDir,
		workspaceDir: rc.workspaceDir,
		backlogDir: rc.backlogDir,
		kbDir: rc.kbDir,
		homeBranch: rc.homeBranch,
		workBranchPrefix: rc.workBranchPrefix,
		pilotName: rc.pilotName,
		pilotEmail: rc.pilotEmail,
		agents: rc.agents,
		effortRef: effort,
	};
	if (rc.backlogDir && effort) bridge.effortPath = resolveFrom(rc.backlogDir, effort);
	return bridge;
}

export function parseEffortRepos(path: string): EffortRepo[] {
	const doc = parseMarkdownDoc(readFileSync(path, "utf8"), path);
	return (doc.fm.lists.repos ?? []).map((rawEntry) => {
		const entry = rawEntry.trim();
		if (!entry) throw new Error(`invalid effort repo entry in ${path}: empty value`);

		const firstColon = entry.indexOf(":");
		const secondColon = firstColon === -1 ? -1 : entry.indexOf(":", firstColon + 1);
		if (secondColon !== -1) {
			throw new Error(
				`invalid effort repo entry in ${path}: ${entry} (expected <repo-id>[@ref][:flags])`,
			);
		}

		const base = firstColon === -1 ? entry : entry.slice(0, firstColon);
		const flagText = firstColon === -1 ? "" : entry.slice(firstColon + 1);
		if (!base) throw new Error(`invalid effort repo entry in ${path}: ${entry} (missing repo id)`);

		let readOnly = false;
		if (firstColon !== -1) {
			if (!flagText)
				throw new Error(`invalid effort repo entry in ${path}: ${entry} (missing flags after :)`);
			for (const flag of flagText.split(",").map((item) => item.trim())) {
				if (!flag) throw new Error(`invalid effort repo entry in ${path}: ${entry} (empty flag)`);
				if (flag === "ro") {
					readOnly = true;
					continue;
				}
				throw new Error(
					`invalid effort repo flag in ${path}: ${entry} (unsupported flag: ${flag})`,
				);
			}
		}

		const at = base.indexOf("@");
		const secondAt = at === -1 ? -1 : base.indexOf("@", at + 1);
		if (secondAt !== -1) {
			throw new Error(`invalid effort repo entry in ${path}: ${entry} (expected at most one @ref)`);
		}

		const id = at === -1 ? base : base.slice(0, at);
		const ref = at === -1 ? undefined : base.slice(at + 1);
		if (!id) throw new Error(`invalid effort repo entry in ${path}: ${entry} (missing repo id)`);
		if (at !== -1 && !ref)
			throw new Error(`invalid effort repo entry in ${path}: ${entry} (missing ref after @)`);

		return { id, ref, readOnly };
	});
}

export function loadKbDocs(kbDir: string, bridgeDir: string): KbDoc[] {
	const entries = readdirSync(kbDir, { withFileTypes: true });
	return entries
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => {
			const path = join(kbDir, e.name);
			const text = readFileSync(path, "utf8");
			const fm = parseMarkdownFrontmatter(text, path);
			const raw = fm.raw;
			return {
				path,
				relPath: relative(bridgeDir, path),
				id: fm.scalars.id,
				name: fm.scalars.name,
				kind: fm.scalars.kind,
				gist: fm.scalars.gist,
				repoPath: fm.nested.meta?.path,
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
		});
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
	const marker = parseYamlBlock(readFileSync(markerPath, "utf8"), markerPath);
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

export function repoDocs(kbDocs: KbDoc[]): KbDoc[] {
	return kbDocs.filter((doc) => doc.kind === "repo");
}
