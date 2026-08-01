import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { effortRefFromPath, resolveEffortPath } from "./backlogDives.js";
import { CommandIo } from "./bridgeSetupIo.js";
import { AGENT_FILENAMES, GIT_LOCAL_ENV_KEYS } from "./constants.js";
import { formatPath, parseMarkdownDoc, resolveFrom } from "./coreParsing.js";
import {
	ApplyPlan,
	EffortRepo,
	GeneratedFrontmatter,
	KbDoc,
	ScopeRef,
	TargetDoc,
	computeApplyTags,
	loadBridgeConfig,
	loadKbDocs,
	readActiveDiveId,
} from "./kbDocs.js";
import { collectBacklog, formatBacklog } from "./packageBacklog.js";
import { assertDir, bridgeRunbookTargets } from "./proveHostRender.js";
import { runGit } from "./repoWorkspaceCore.js";

export function agentFilenames(agents: string[], warnings: string[]): string[] {
	const filenames: string[] = [];
	for (const agent of agents) {
		const filename = AGENT_FILENAMES[agent];
		if (!filename) {
			warnings.push(`unknown agent in .nosediverc; skipping generated docs for ${agent}`);
			continue;
		}
		if (!filenames.includes(filename)) filenames.push(filename);
	}
	if (filenames.length === 0) throw new Error("no supported agents configured in .nosediverc");
	return filenames;
}

export const FOUNDATION_FILTER_KEYS = [
	"include-if-any",
	"include-if-all",
	"exclude-if-any",
	"exclude-if-all",
] as const;

export type FoundationFilterKey = (typeof FOUNDATION_FILTER_KEYS)[number];

export function metaFilterTags(doc: KbDoc, key: FoundationFilterKey): string[] {
	const list = doc.metaLists[key];
	if (list && list.length > 0) return list.map((tag) => tag.trim()).filter(Boolean);
	const scalar = doc.metaScalars[key];
	return scalar ? [scalar.trim()].filter(Boolean) : [];
}

export function selectedFoundationFilter(
	doc: KbDoc,
	warnings: string[],
): { key: FoundationFilterKey; tags: string[] } | undefined {
	const filters = FOUNDATION_FILTER_KEYS.map((key) => ({
		key,
		tags: metaFilterTags(doc, key),
	})).filter((filter) => filter.tags.length > 0);

	if (filters.length > 1) {
		warnings.push(
			`foundation doc ${doc.relPath} has multiple include/exclude meta filters; skipping`,
		);
		return undefined;
	}
	return filters[0];
}

export function foundationFilterAllows(doc: KbDoc, tags: Set<string>, warnings: string[]): boolean {
	const filter = selectedFoundationFilter(doc, warnings);
	if (!filter) {
		return !FOUNDATION_FILTER_KEYS.some(
			(key) => Object.hasOwn(doc.metaLists, key) || Object.hasOwn(doc.metaScalars, key),
		);
	}

	if (filter.key === "include-if-any") return filter.tags.some((tag) => tags.has(tag));
	if (filter.key === "include-if-all") return filter.tags.every((tag) => tags.has(tag));
	if (filter.key === "exclude-if-any") return !filter.tags.some((tag) => tags.has(tag));
	return !filter.tags.every((tag) => tags.has(tag));
}

export function scopeMatchesAnyRepo(scope: ScopeRef, repoIds: Set<string>): boolean {
	return repoIds.has(scope.repoId);
}

export function foundationBridgeTargets(options: {
	kbDocs: KbDoc[];
	activeRepoIds: Set<string>;
	tags: Set<string>;
	warnings: string[];
}): TargetDoc[] {
	const { kbDocs, activeRepoIds, tags, warnings } = options;
	const targets: TargetDoc[] = [];

	for (const doc of kbDocs.filter((item) => item.kind === "foundation")) {
		if (doc.scopes.length === 0) {
			if (!foundationFilterAllows(doc, tags, warnings)) continue;
			targets.push({ doc, repoId: "", render: "body", scopePath: "", readOnly: false });
			continue;
		}

		if (activeRepoIds.size === 0) continue;
		if (!doc.scopes.some((scope) => scopeMatchesAnyRepo(scope, activeRepoIds))) continue;
		if (!foundationFilterAllows(doc, tags, warnings)) continue;
		targets.push({ doc, repoId: "", render: "body", scopePath: "", readOnly: false });
	}

	return targets;
}

export function activeDiveRepos(dive: KbDoc | undefined): EffortRepo[] {
	if (!dive) return [];
	const repos = new Map<string, EffortRepo>();
	for (const scope of dive.scopes) {
		if (scope.repoId === ".") continue;
		if (!repos.has(scope.repoId))
			repos.set(scope.repoId, { id: scope.repoId, ref: scope.ref, readOnly: scope.readOnly });
	}
	return [...repos.values()];
}

export function createApplyPlan(): ApplyPlan {
	const bridge = loadBridgeConfig(process.cwd());
	assertDir(bridge.kbDir, "kb");
	const kbDocs = loadKbDocs(bridge.kbDir, bridge.bridgeDir);
	const repoDocs = new Map(kbDocs.filter((doc) => doc.kind === "repo").map((doc) => [doc.id, doc]));
	const warnings: string[] = [];
	const agentFiles = agentFilenames(bridge.agents, warnings);
	const activeDiveId = readActiveDiveId(bridge.workspaceDir);
	const activeDive = activeDiveId
		? kbDocs.find((doc) => doc.kind === "dive" && doc.id === activeDiveId)
		: undefined;
	if (activeDiveId && !activeDive)
		warnings.push(`active dive marker points at missing kind: dive doc: ${activeDiveId}`);
	bridge.activeDiveId = activeDiveId;
	if (activeDive?.effortRef && bridge.backlogDir) {
		bridge.effortRef = effortRefFromPath(
			resolveEffortPath(
				activeDive.effortRef,
				bridge.bridgeDir,
				bridge.backlogDir,
				"active dive effort",
			),
			bridge.backlogDir,
		);
		bridge.effortPath = resolveFrom(bridge.backlogDir, bridge.effortRef);
	}
	const tags = computeApplyTags(bridge);
	const targets = new Map<string, TargetDoc[]>();
	let repos: Array<EffortRepo & { repoPath?: string; repoBaseBranch: string; repoRef: string }> =
		[];

	const activeRepos = activeDiveRepos(activeDive);
	const activeRepoIds = new Set(activeRepos.map((repo) => repo.id));
	targets.set(bridge.bridgeDir, [
		...foundationBridgeTargets({ kbDocs, activeRepoIds, tags, warnings }),
		...bridgeRunbookTargets(kbDocs),
	]);

	if (activeRepos.length > 0) {
		repos = activeRepos.map((repo) => {
			const repoDoc = repoDocs.get(repo.id);
			const repoBaseBranch = repoDoc?.repoBaseBranch ?? "main";
			return {
				...repo,
				repoPath: repoDoc?.repoPath,
				repoBaseBranch,
				repoRef: repo.ref ?? repoBaseBranch,
			};
		});
	}

	return { bridge, repos, agentFiles, tags, targets, warnings };
}

export function applyDryRun(io: CommandIo): void {
	const { bridge, repos, agentFiles, tags, targets, warnings } = createApplyPlan();

	io.log("nosedive apply --dry-run");
	io.log(`Bridge:    ${formatPath(bridge.bridgeDir)}`);
	io.log(
		`Workspace: ${bridge.workspaceDir ? formatPath(bridge.workspaceDir) : "(not configured)"}`,
	);
	io.log(`Backlog:   ${bridge.backlogDir ? formatPath(bridge.backlogDir) : "(not configured)"}`);
	io.log(`KB:        ${formatPath(bridge.kbDir)}`);
	io.log(`Home:      ${bridge.homeBranch ?? "(not configured)"}`);
	io.log(`Work ref:  ${bridge.workBranchPrefix ?? "(not configured)"}`);
	io.log(`Pilot:     ${bridge.pilotName ?? "(no name)"} <${bridge.pilotEmail ?? "no email"}>`);
	io.log(`Effort:    ${bridge.effortRef ?? "(not configured)"}`);
	io.log(`Dive:      ${bridge.activeDiveId ?? "(not configured)"}`);
	io.log(`Tags:      ${tags.size > 0 ? [...tags].sort().join(", ") : "(none)"}`);
	io.log("");

	io.log("Bridge docs:");
	for (const filename of agentFiles) io.log(`  ${join(formatPath(bridge.bridgeDir), filename)}`);
	for (const item of (targets.get(bridge.bridgeDir) ?? []).sort((a, b) =>
		a.doc.relPath.localeCompare(b.doc.relPath),
	)) {
		io.log(`    - ${item.doc.relPath} :${item.render}`);
	}
	io.log("");

	if (repos.length > 0) {
		io.log("Repos:");
		for (const repo of repos) {
			const path = repo.repoPath ?? "(missing repo doc)";
			const mode = repo.readOnly ? "read-only" : "writable";
			const refSummary = repo.ref
				? `ref ${repo.repoRef} (base ${repo.repoBaseBranch})`
				: `base ${repo.repoBaseBranch}`;
			io.log(`  ${mode.padEnd(9)} ${path} (${repo.id}, ${refSummary})`);
		}
		io.log("");
	}

	if (warnings.length > 0) {
		io.log("");
		io.log("Warnings:");
		for (const warning of warnings) io.log(`  - ${warning}`);
	}

	io.log("");
	io.log("No files written.");
}

export function markdownList(items: string[]): string {
	if (items.length === 0) return "- (none)";
	return items.map((item) => `- \`${item}\``).join("\n");
}

export function renderWorkspaceDoc(plan: ApplyPlan): string {
	const effortPath = plan.bridge.effortPath!;
	const backlogDir = plan.bridge.backlogDir!;
	const effortBody = parseMarkdownDoc(readFileSync(effortPath, "utf8"), effortPath).body.trim();
	const writable = plan.repos
		.filter((repo) => !repo.readOnly && repo.repoPath)
		.map((repo) => resolveFrom(plan.bridge.bridgeDir, repo.repoPath!))
		.sort((a, b) => a.localeCompare(b));
	const readOnly = plan.repos
		.filter((repo) => repo.readOnly && repo.repoPath)
		.map((repo) => resolveFrom(plan.bridge.bridgeDir, repo.repoPath!))
		.sort((a, b) => a.localeCompare(b));
	const backlog = formatBacklog(collectBacklog(backlogDir), true);

	return [
		effortBody,
		"",
		"## Allowed Paths",
		"",
		"### Writable",
		"",
		markdownList(writable),
		"",
		"### Read-only",
		"",
		markdownList(readOnly),
		"",
		"## Boundary",
		"",
		"Only the paths listed above are part of this effort. Do not inspect or edit other directories unless the user explicitly expands the effort.",
		"",
		"## Open Efforts",
		"",
		"```text",
		backlog,
		"```",
		"",
	].join("\n");
}

export function renderGistBlock(doc: KbDoc): string {
	const title = doc.id ? `${doc.kind || "doc"} ${doc.id}` : doc.relPath;
	return [`## ${title}`, "", doc.gist || "(no gist)", "", `Source: \`${doc.relPath}\``, ""].join(
		"\n",
	);
}

export function renderRunbookGistBlock(doc: KbDoc): string {
	const title = doc.name || doc.id || doc.relPath;
	return [
		`### \`${title}\``,
		"",
		doc.gist || "(no gist)",
		"",
		`Source: \`${doc.relPath}\``,
		"",
	].join("\n");
}

export function renderBodyBlock(doc: KbDoc): string {
	const body = parseMarkdownDoc(readFileSync(doc.path, "utf8"), doc.path).body.trim();
	return [`<!-- Source: ${doc.relPath} -->`, "", body, ""].join("\n");
}

export function renderRepoDoc(targetDir: string, docs: TargetDoc[]): string {
	const readOnly = docs.some((item) => item.readOnly);
	const sortedDocs = docs.sort((a, b) => a.doc.relPath.localeCompare(b.doc.relPath));
	const runbookItems = sortedDocs
		.filter((item) => item.render === "gist" && item.doc.kind === "runbook")
		.sort((a, b) => a.doc.name.localeCompare(b.doc.name));
	const nonRunbookBlocks = sortedDocs
		.filter((item) => item.doc.kind !== "runbook")
		.map((item) =>
			item.render === "body" ? renderBodyBlock(item.doc) : renderGistBlock(item.doc),
		);

	const header: string[] = [];
	if (readOnly) {
		header.push(
			"## Read-only For This Effort",
			"",
			"This repository is read-only for the current effort. Do not edit files or create commits here.",
			"",
		);
	}

	const runbookBlocks =
		runbookItems.length === 0
			? []
			: [
					"## Available Runbooks",
					"",
					"If the user asks what runbooks are available or what they can do, answer from this list with runbook names and gists.",
					"If the user asks to do something that sounds like one of these runbooks, read the full source doc before taking the runbook.",
					"",
					...runbookItems.map((item) => renderRunbookGistBlock(item.doc)),
				];

	return [...header, ...nonRunbookBlocks, ...runbookBlocks].join("\n");
}

export function quoteYamlString(value: string): string {
	return JSON.stringify(value);
}

export function renderGeneratedFrontmatter(
	filename: string,
	frontmatter?: GeneratedFrontmatter,
): string {
	const lines = [
		`generated-by: "nosedive"`,
		`generated-file: ${quoteYamlString(filename)}`,
		"do-not-edit: true",
		`gist: "Generated by nosedive from kb; do not edit by hand."`,
	];
	if (frontmatter?.effort) lines.push(`effort: ${quoteYamlString(frontmatter.effort)}`);
	if (frontmatter?.repoId) lines.push(`repo-id: ${quoteYamlString(frontmatter.repoId)}`);
	if (frontmatter?.scopePath) lines.push(`scope-path: ${quoteYamlString(frontmatter.scopePath)}`);
	return ["---", ...lines, "---", ""].join("\n");
}

export function withGeneratedEnvelope(
	filename: string,
	content: string,
	frontmatter?: GeneratedFrontmatter,
): string {
	const trimmed = content.replace(/^\n+/, "");
	return `${renderGeneratedFrontmatter(filename, frontmatter)}${trimmed}`;
}

export function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(
		dirname(path),
		`.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

export function writeAgentFiles(
	dir: string,
	filenames: string[],
	content: string,
	frontmatter?: GeneratedFrontmatter,
): string[] {
	const paths = filenames.map((filename) => join(dir, filename));
	for (const filename of filenames)
		writeFileAtomic(join(dir, filename), withGeneratedEnvelope(filename, content, frontmatter));
	return paths;
}

export function cleanGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of GIT_LOCAL_ENV_KEYS) delete env[key];
	return env;
}

export function gitOutput(cwd: string, args: string[]): string | undefined {
	const result = runGit(cwd, args);
	if (result.status !== 0) return undefined;
	return result.stdout.trim();
}

export function gitOk(cwd: string, args: string[]): boolean {
	return runGit(cwd, args).status === 0;
}

export function executableForSpawn(command: string): string {
	if (process.platform === "win32" && (command === "npm" || command === "npx")) {
		return `${command}.cmd`;
	}
	return command;
}
