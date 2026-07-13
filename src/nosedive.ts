#!/usr/bin/env node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { parse as parseYaml, parseDocument } from "yaml";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const MANAGED_EXCLUDE_BEGIN = "# BEGIN nosedive-managed exclude";
const MANAGED_EXCLUDE_END = "# END nosedive-managed exclude";
const MANAGED_EXCLUDE_BLOCK = [
  MANAGED_EXCLUDE_BEGIN,
  "# kb: 019f5651-5539-76f5-b6bd-351d300194eb",
  "# name: nosedive-managed-local-git-state",
  "# owner: nosedive apply",
  "# reason: generated agent instruction files are local workspace artifacts",
  "CLAUDE.md",
  "AGENTS.md",
  MANAGED_EXCLUDE_END,
].join("\n");
const GIT_LOCAL_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
];

const USAGE = `Usage: nosedive <command>

Commands:
  version       Print the package version
  dump-backlog  Print the open efforts in the configured backlog
  apply         Materialize scoped agent docs for the current effort
`;

// --- frontmatter -----------------------------------------------------------

interface SimpleYaml {
  scalars: Record<string, string>;
  lists: Record<string, string[]>;
  nested: Record<string, Record<string, string>>;
}

interface MarkdownDoc {
  fm: SimpleYaml;
  body: string;
}

export interface NosediveRc {
  path: string;
  bridgeDir: string;
  workspaceDir?: string;
  backlogDir?: string;
  kbDir?: string;
  sessionsDir?: string;
  homeBranch?: string;
  workBranchPrefix?: string;
  current: {
    effort?: string;
    session?: string;
  };
}

export interface NosediveRcCurrent {
  effort?: string;
  session?: string;
}

function emptyYaml(): SimpleYaml {
  return { scalars: {}, lists: {}, nested: {} };
}

function scalarToString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object") return undefined;
  return String(value);
}

/** Normalize valid YAML into the small shape nosedive callers consume. */
function normalizeYaml(value: unknown): SimpleYaml {
  const out = emptyYaml();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(item)) {
      out.lists[key] = item.map((entry) => scalarToString(entry)).filter((entry): entry is string => entry !== undefined);
      continue;
    }

    if (item && typeof item === "object") {
      const nested: Record<string, string> = {};
      for (const [nestedKey, nestedItem] of Object.entries(item as Record<string, unknown>)) {
        const scalar = scalarToString(nestedItem);
        if (scalar !== undefined) nested[nestedKey] = scalar;
      }
      out.nested[key] = nested;
      continue;
    }

    const scalar = scalarToString(item);
    if (scalar !== undefined) out.scalars[key] = scalar;
  }

  return out;
}

function parseYamlBlock(block: string, label: string): SimpleYaml {
  try {
    return normalizeYaml(parseYaml(block));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid YAML in ${label}: ${detail}`);
  }
}

/** Parse leading `---` YAML frontmatter and return the body separately. */
function parseMarkdownDoc(text: string, label = "markdown frontmatter"): MarkdownDoc {
  if (!text.startsWith("---")) return { fm: emptyYaml(), body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: emptyYaml(), body: text };
  const bodyStart = text.indexOf("\n", end + 4);
  return {
    fm: parseYamlBlock(text.slice(3, end), `frontmatter in ${label}`),
    body: bodyStart === -1 ? "" : text.slice(bodyStart + 1),
  };
}

/** Parse only leading `---` YAML frontmatter. */
function parseMarkdownFrontmatter(text: string, label = "markdown document"): SimpleYaml {
  if (!text.startsWith("---")) return emptyYaml();
  const end = text.indexOf("\n---", 3);
  if (end === -1) return emptyYaml();
  return parseYamlBlock(text.slice(3, end), `frontmatter in ${label}`);
}

/** Parse leading `---` YAML frontmatter into a flat string map. */
function parseFrontmatter(text: string, label = "markdown frontmatter"): Record<string, string> {
  return parseMarkdownDoc(text, label).fm.scalars;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "...";
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

function resolveFrom(base: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

function formatPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel || "." : path;
}

function findBridgeConfig(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    const candidate = join(dir, ".nosediverc");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readNosediveRc(start: string): NosediveRc {
  const rcPath = findBridgeConfig(start);
  if (!rcPath) throw new Error("not inside a nosedive bridge: no .nosediverc found");

  const bridgeDir = dirname(rcPath);
  const rc = parseYamlBlock(readFileSync(rcPath, "utf8"), rcPath);
  const workspace = rc.scalars.workspace;
  const backlog = rc.scalars.backlog;
  const kb = rc.scalars.kb;
  const sessions = rc.scalars.sessions;

  return {
    path: rcPath,
    bridgeDir,
    workspaceDir: workspace ? resolveFrom(bridgeDir, workspace) : undefined,
    backlogDir: backlog ? resolveFrom(bridgeDir, backlog) : undefined,
    kbDir: kb ? resolveFrom(bridgeDir, kb) : undefined,
    sessionsDir: sessions ? resolveFrom(bridgeDir, sessions) : undefined,
    homeBranch: rc.scalars["home-branch"],
    workBranchPrefix: rc.scalars["work-branch-prefix"],
    current: {
      effort: rc.nested.current?.effort,
      session: rc.nested.current?.session,
    },
  };
}

export function writeNosediveRcCurrent(start: string, current?: NosediveRcCurrent): void {
  const rcPath = findBridgeConfig(start);
  if (!rcPath) throw new Error("not inside a nosedive bridge: no .nosediverc found");

  const doc = parseDocument(readFileSync(rcPath, "utf8"));
  if (doc.errors.length > 0) throw new Error(`invalid YAML in ${rcPath}: ${doc.errors[0]?.message ?? "unknown error"}`);

  if (!current?.effort && !current?.session) {
    doc.deleteIn(["current"]);
  } else {
    doc.setIn(["current", "effort"], current.effort ?? null);
    doc.setIn(["current", "session"], current.session ?? null);
    if (!current.effort) doc.deleteIn(["current", "effort"]);
    if (!current.session) doc.deleteIn(["current", "session"]);
  }

  writeFileAtomic(rcPath, doc.toString());
}

// --- efforts ---------------------------------------------------------------

interface Effort {
  depth: number;
  chain: string; // slug chain, leaf-first, dot-joined
  path: string;
  phase: string;
  gist: string;
}

interface BacklogConfig {
  bridgeDir: string;
  backlogDir: string;
}

/** Walk one effort folder: emit it if open, then recurse into child folders. */
function walkEffort(dir: string, slug: string, ancestors: string[], out: Effort[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  const md = entries.find((e) => e.isFile() && e.name.endsWith(".md"));
  if (md) {
    // Presence under backlog/ means open; finished work leaves for kb/.
    const path = join(dir, md.name);
    const text = readFileSync(path, "utf8");
    const fm = parseFrontmatter(text, path);
    out.push({
      depth: ancestors.length,
      chain: [slug, ...ancestors].join("."),
      path,
      phase: fm.phase || "unknown",
      gist: fm.gist || "",
    });
  }
  const chain = [slug, ...ancestors];
  for (const e of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    walkEffort(join(dir, e.name), e.name, chain, out);
  }
}

function collectEfforts(effortsDir: string): Effort[] {
  const out: Effort[] = [];
  let top: Dirent[];
  try {
    top = readdirSync(effortsDir, { withFileTypes: true });
  } catch {
    return out; // missing efforts/ dir -> empty backlog
  }
  for (const e of top.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    walkEffort(join(effortsDir, e.name), e.name, [], out);
  }
  return out;
}

function loadBacklogConfig(start: string): BacklogConfig {
  const rc = readNosediveRc(start);

  if (!rc.backlogDir) throw new Error(".nosediverc is missing backlog");
  return { bridgeDir: rc.bridgeDir, backlogDir: rc.backlogDir };
}

function formatBacklog(efforts: Effort[], verbose: boolean): string {
  if (efforts.length === 0) {
    return "No open efforts.";
  }

  // Fixed column where the slug chain starts, past the (indented) phase field.
  const col = Math.max(13, ...efforts.map((e) => e.depth * 2 + e.phase.length + 2));
  const lines: string[] = [];
  for (const e of efforts) {
    const prefix = " ".repeat(e.depth * 2) + e.phase;
    lines.push(prefix.padEnd(col) + e.chain);
    if (verbose) lines.push(" ".repeat(col) + e.path);
    if (e.gist) lines.push(" ".repeat(col) + truncate(e.gist, 72));
  }
  return lines.join("\n");
}

function dumpBacklog(args: string[]): void {
  const verbose = args.includes("--verbose");
  const unknown = args.filter((arg) => arg !== "--verbose");
  if (unknown.length > 0) throw new Error(`unknown dump-backlog option: ${unknown[0]}`);

  const { backlogDir } = loadBacklogConfig(process.cwd());
  console.log(formatBacklog(collectEfforts(backlogDir), verbose));
}

// --- apply -----------------------------------------------------------------

interface BridgeConfig {
  bridgeDir: string;
  workspaceDir?: string;
  backlogDir?: string;
  kbDir: string;
  sessionsDir?: string;
  homeBranch?: string;
  workBranchPrefix?: string;
  effortPath?: string;
  effortRef?: string;
  sessionRef?: string;
}

interface EffortRepo {
  id: string;
  readOnly: boolean;
}

interface KbDoc {
  path: string;
  relPath: string;
  id: string;
  kind: string;
  gist: string;
  repoPath?: string;
  scopes: string[];
}

interface ScopeRef {
  repoId: string;
  path: string;
  render?: "body" | "gist";
}

interface TargetDoc {
  doc: KbDoc;
  repoId: string;
  render: "body" | "gist";
  scopePath: string;
  readOnly: boolean;
}

interface GeneratedFrontmatter {
  effort?: string;
  repoId?: string;
  scopePath?: string;
}

interface ApplyPlan {
  bridge: BridgeConfig;
  repos: Array<EffortRepo & { repoPath?: string }>;
  targets: Map<string, TargetDoc[]>;
  warnings: string[];
}

function loadBridgeConfig(start: string): BridgeConfig {
  const rc = readNosediveRc(start);
  const effort = rc.current.effort;

  if (!rc.kbDir) throw new Error(".nosediverc is missing kb");

  const bridge: BridgeConfig = {
    bridgeDir: rc.bridgeDir,
    workspaceDir: rc.workspaceDir,
    backlogDir: rc.backlogDir,
    kbDir: rc.kbDir,
    sessionsDir: rc.sessionsDir,
    homeBranch: rc.homeBranch,
    workBranchPrefix: rc.workBranchPrefix,
    effortRef: effort,
    sessionRef: rc.current.session,
  };
  if (rc.backlogDir && effort) bridge.effortPath = resolveFrom(rc.backlogDir, effort);
  return bridge;
}

function parseEffortRepos(path: string): EffortRepo[] {
  const doc = parseMarkdownDoc(readFileSync(path, "utf8"), path);
  return (doc.fm.lists.repos ?? []).map((entry) => {
    if (entry.endsWith(":ro")) return { id: entry.slice(0, -3), readOnly: true };
    return { id: entry, readOnly: false };
  });
}

function loadKbDocs(kbDir: string, bridgeDir: string): KbDoc[] {
  const entries = readdirSync(kbDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => {
      const path = join(kbDir, e.name);
      const fm = parseMarkdownFrontmatter(readFileSync(path, "utf8"), path);
      return {
        path,
        relPath: relative(bridgeDir, path),
        id: fm.scalars.id,
        kind: fm.scalars.kind,
        gist: fm.scalars.gist,
        repoPath: fm.nested.meta?.path,
        scopes: fm.lists.scopes ?? [],
      };
    });
}

function parseScopeRef(scope: string): ScopeRef | undefined {
  const renderMatch = scope.match(/:(body|gist)$/);
  const render = renderMatch?.[1] as "body" | "gist" | undefined;
  const withoutRender = render ? scope.slice(0, -1 * (render.length + 1)) : scope;
  const slash = withoutRender.indexOf("/");
  const repoId = slash === -1 ? withoutRender : withoutRender.slice(0, slash);
  const path = slash === -1 ? "" : withoutRender.slice(slash + 1);
  if (!repoId) return undefined;
  return { repoId, path, render };
}

function defaultRender(kind: string): "body" | "gist" | undefined {
  if (kind === "foundation") return "body";
  if (kind === "convention" || kind === "skill") return "gist";
  return undefined;
}

function assertDir(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
  if (!statSync(path).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function addScopedRepoTargets(options: {
  kbDocs: KbDoc[];
  repoId: string;
  repoRoot: string;
  readOnly: boolean;
  repoLabel: string;
  targets: Map<string, TargetDoc[]>;
  warnings: string[];
}): void {
  const { kbDocs, repoId, repoRoot, readOnly, repoLabel, targets, warnings } = options;

  for (const doc of kbDocs) {
    if (doc.kind === "repo") continue;
    const renderDefault = defaultRender(doc.kind);
    if (!renderDefault) continue;

    for (const rawScope of doc.scopes) {
      const scope = parseScopeRef(rawScope);
      if (!scope || scope.repoId !== repoId) continue;

      const targetDir = scope.path ? resolve(repoRoot, scope.path) : repoRoot;
      if (!existsSync(targetDir)) {
        warnings.push(`scope path does not exist; skipping ${doc.relPath} -> ${repoLabel}/${scope.path}`);
        continue;
      }

      const render = scope.render ?? renderDefault;
      const list = targets.get(targetDir) ?? [];
      if (!list.some((item) => item.doc.path === doc.path && item.render === render && item.scopePath === scope.path)) {
        list.push({ doc, repoId, render, scopePath: scope.path, readOnly });
      }
      targets.set(targetDir, list);
    }
  }
}

function shouldGenerateWorkspaceDocs(bridge: BridgeConfig): boolean {
  return Boolean(bridge.workspaceDir && bridge.backlogDir && bridge.effortPath && bridge.effortRef);
}

function createApplyPlan(): ApplyPlan {
  const bridge = loadBridgeConfig(process.cwd());
  assertDir(bridge.kbDir, "kb");
  const kbDocs = loadKbDocs(bridge.kbDir, bridge.bridgeDir);
  const repoDocs = new Map(kbDocs.filter((doc) => doc.kind === "repo").map((doc) => [doc.id, doc]));
  const warnings: string[] = [];
  const targets = new Map<string, TargetDoc[]>();
  let repos: Array<EffortRepo & { repoPath?: string }> = [];

  const foundationDocs = kbDocs.filter((doc) => doc.kind === "foundation");
  targets.set(
    bridge.bridgeDir,
    foundationDocs.map((doc) => ({ doc, repoId: "", render: "body", scopePath: "", readOnly: false })),
  );

  if (shouldGenerateWorkspaceDocs(bridge)) {
    assertDir(bridge.backlogDir!, "backlog");
    if (!existsSync(bridge.effortPath!)) throw new Error(`current effort does not exist: ${bridge.effortPath}`);

    const effortRepos = parseEffortRepos(bridge.effortPath!);
    repos = effortRepos.map((repo) => ({ ...repo, repoPath: repoDocs.get(repo.id)?.repoPath }));

    for (const repo of effortRepos) {
      const repoDoc = repoDocs.get(repo.id);
      if (!repoDoc) {
        warnings.push(`effort repo has no kind: repo kb doc: ${repo.id}`);
        continue;
      }
      if (!repoDoc.repoPath) {
        warnings.push(`repo doc ${repoDoc.relPath} is missing meta.path`);
        continue;
      }

      const repoRoot = resolveFrom(bridge.bridgeDir, repoDoc.repoPath);
      if (!existsSync(repoRoot)) {
        warnings.push(`repo path does not exist; skipping scoped docs for ${repo.id}: ${repoRoot}`);
        continue;
      }

      addScopedRepoTargets({
        kbDocs,
        repoId: repo.id,
        repoRoot,
        readOnly: repo.readOnly,
        repoLabel: repoDoc.repoPath,
        targets,
        warnings,
      });
    }
  } else if (bridge.workspaceDir || bridge.backlogDir || bridge.effortRef) {
    warnings.push("workspace docs skipped because .nosediverc does not set workspace, backlog, and current.effort");
  }

  return { bridge, repos, targets, warnings };
}

function applyDryRun(): void {
  const { bridge, repos, targets, warnings } = createApplyPlan();

  console.log("nosedive apply --dry-run");
  console.log(`Bridge:    ${formatPath(bridge.bridgeDir)}`);
  console.log(`Workspace: ${bridge.workspaceDir ? formatPath(bridge.workspaceDir) : "(not configured)"}`);
  console.log(`Backlog:   ${bridge.backlogDir ? formatPath(bridge.backlogDir) : "(not configured)"}`);
  console.log(`KB:        ${formatPath(bridge.kbDir)}`);
  console.log(`Sessions:  ${bridge.sessionsDir ? formatPath(bridge.sessionsDir) : "(not configured)"}`);
  console.log(`Home:      ${bridge.homeBranch ?? "(not configured)"}`);
  console.log(`Work ref:  ${bridge.workBranchPrefix ?? "(not configured)"}`);
  console.log(`Effort:    ${bridge.effortRef ?? "(not configured)"}`);
  console.log(`Session:   ${bridge.sessionRef ?? "(not configured)"}`);
  console.log("");

  console.log("Bridge docs:");
  console.log(`  ${join(formatPath(bridge.bridgeDir), "CLAUDE.md")}`);
  console.log(`  ${join(formatPath(bridge.bridgeDir), "AGENTS.md")}`);
  for (const item of (targets.get(bridge.bridgeDir) ?? []).sort((a, b) => a.doc.relPath.localeCompare(b.doc.relPath))) {
    console.log(`    - ${item.doc.relPath} :${item.render}`);
  }
  console.log("");

  if (shouldGenerateWorkspaceDocs(bridge)) {
    console.log("Workspace docs:");
    console.log(`  ${join(formatPath(bridge.workspaceDir!), "CLAUDE.md")}`);
    console.log(`  ${join(formatPath(bridge.workspaceDir!), "AGENTS.md")}`);
    if (!existsSync(bridge.workspaceDir!)) warnings.push(`workspace does not exist: ${bridge.workspaceDir}`);
    console.log("");

    console.log("Repos:");
    for (const repo of repos) {
      const path = repo.repoPath ?? "(missing repo doc)";
      const mode = repo.readOnly ? "read-only" : "writable";
      console.log(`  ${mode.padEnd(9)} ${path} (${repo.id})`);
    }
    console.log("");
  }

  console.log("Repo docs:");
  const repoTargets = [...targets.entries()].filter(([targetDir]) => targetDir !== bridge.bridgeDir);
  if (repoTargets.length === 0) {
    console.log("  (none)");
  } else {
    for (const [targetDir, docs] of repoTargets.sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${join(formatPath(targetDir), "CLAUDE.md")}`);
      console.log(`  ${join(formatPath(targetDir), "AGENTS.md")}`);
      for (const item of docs.sort((a, b) => a.doc.relPath.localeCompare(b.doc.relPath))) {
        const suffix = item.scopePath ? ` scope=${item.scopePath}` : "";
        console.log(`    - ${item.doc.relPath} :${item.render}${suffix}`);
      }
    }
  }

  if (warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of warnings) console.log(`  - ${warning}`);
  }

  console.log("");
  console.log("No files written.");
}

function markdownList(items: string[]): string {
  if (items.length === 0) return "- (none)";
  return items.map((item) => `- \`${item}\``).join("\n");
}

function renderWorkspaceDoc(plan: ApplyPlan): string {
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
  const backlog = formatBacklog(collectEfforts(backlogDir), true);

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

function renderGistBlock(doc: KbDoc): string {
  const title = doc.id ? `${doc.kind || "doc"} ${doc.id}` : doc.relPath;
  return [`## ${title}`, "", doc.gist || "(no gist)", "", `Source: \`${doc.relPath}\``, ""].join("\n");
}

function renderBodyBlock(doc: KbDoc): string {
  const body = parseMarkdownDoc(readFileSync(doc.path, "utf8"), doc.path).body.trim();
  return [`<!-- Source: ${doc.relPath} -->`, "", body, ""].join("\n");
}

function renderRepoDoc(targetDir: string, docs: TargetDoc[]): string {
  const readOnly = docs.some((item) => item.readOnly);
  const blocks = docs
    .sort((a, b) => a.doc.relPath.localeCompare(b.doc.relPath))
    .map((item) => (item.render === "body" ? renderBodyBlock(item.doc) : renderGistBlock(item.doc)));

  const header: string[] = [];
  if (readOnly) {
    header.push(
      "## Read-only For This Effort",
      "",
      "This repository is read-only for the current effort. Do not edit files or create commits here.",
      "",
    );
  }

  return [...header, ...blocks].join("\n");
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function renderGeneratedFrontmatter(filename: string, frontmatter?: GeneratedFrontmatter): string {
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

function withGeneratedEnvelope(filename: string, content: string, frontmatter?: GeneratedFrontmatter): string {
  const trimmed = content.replace(/^\n+/, "");
  return `${renderGeneratedFrontmatter(filename, frontmatter)}${trimmed}`;
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function writeAgentPair(dir: string, content: string, frontmatter?: GeneratedFrontmatter): string[] {
  const filenames = ["CLAUDE.md", "AGENTS.md"];
  const paths = filenames.map((filename) => join(dir, filename));
  for (const filename of filenames) writeFileAtomic(join(dir, filename), withGeneratedEnvelope(filename, content, frontmatter));
  return paths;
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_LOCAL_ENV_KEYS) delete env[key];
  return env;
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanGitEnv() });
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

function gitOk(cwd: string, args: string[]): boolean {
  return spawnSync("git", args, { cwd, encoding: "utf8", env: cleanGitEnv() }).status === 0;
}

function gitRelPath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function removeManagedExcludeBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== MANAGED_EXCLUDE_BEGIN) {
      out.push(lines[i]);
      continue;
    }

    const end = lines.indexOf(MANAGED_EXCLUDE_END, i + 1);
    if (end === -1) {
      out.push(lines[i]);
      continue;
    }
    i = end;
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

function replaceManagedExcludeBlock(text: string): string {
  const withoutManaged = removeManagedExcludeBlocks(text);
  const prefix = withoutManaged.trim() ? `${withoutManaged.replace(/\n*$/, "\n")}\n` : "";
  return `${prefix}${MANAGED_EXCLUDE_BLOCK}\n`;
}

function updateManagedExclude(repoRoot: string, warnings: string[]): void {
  const rawExcludePath = gitOutput(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
  if (!rawExcludePath) {
    warnings.push(`could not resolve git exclude path for ${repoRoot}`);
    return;
  }

  const excludePath = isAbsolute(rawExcludePath) ? rawExcludePath : resolve(repoRoot, rawExcludePath);
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  writeFileAtomic(excludePath, replaceManagedExcludeBlock(existing));
}

function manageGeneratedGitState(paths: string[]): string[] {
  const warnings: string[] = [];
  const byRepo = new Map<string, string[]>();

  for (const path of paths) {
    const repoRoot = gitOutput(dirname(path), ["rev-parse", "--show-toplevel"]);
    if (!repoRoot) {
      warnings.push(`generated file is not inside a git worktree; cannot manage excludes: ${path}`);
      continue;
    }
    const list = byRepo.get(repoRoot) ?? [];
    list.push(path);
    byRepo.set(repoRoot, list);
  }

  for (const [repoRoot, files] of byRepo) {
    updateManagedExclude(repoRoot, warnings);

    for (const file of files) {
      const rel = gitRelPath(repoRoot, file);
      if (!gitOk(repoRoot, ["ls-files", "--error-unmatch", "--", rel])) continue;

      if (gitOk(repoRoot, ["update-index", "--skip-worktree", "--", rel])) {
        warnings.push(`tracked generated file marked skip-worktree: ${file}`);
      } else {
        warnings.push(`could not mark tracked generated file skip-worktree: ${file}`);
      }
    }
  }

  return warnings;
}

function repoFrontmatter(bridge: BridgeConfig, docs: TargetDoc[]): GeneratedFrontmatter | undefined {
  const first = docs[0];
  if (!bridge.effortRef || !first?.repoId) return undefined;
  return {
    effort: bridge.effortRef,
    repoId: first.repoId,
    scopePath: first.scopePath || ".",
  };
}

function applyWrite(): void {
  const plan = createApplyPlan();
  const generatedFiles: string[] = [];
  const repoDocPairCount = [...plan.targets.keys()].filter((targetDir) => targetDir !== plan.bridge.bridgeDir).length;

  generatedFiles.push(...writeAgentPair(plan.bridge.bridgeDir, renderRepoDoc(plan.bridge.bridgeDir, plan.targets.get(plan.bridge.bridgeDir) ?? [])));

  if (shouldGenerateWorkspaceDocs(plan.bridge)) {
    assertDir(plan.bridge.workspaceDir!, "workspace");
    const workspaceContent = renderWorkspaceDoc(plan);
    generatedFiles.push(...writeAgentPair(plan.bridge.workspaceDir!, workspaceContent, { effort: plan.bridge.effortRef }));
  }

  for (const [targetDir, docs] of plan.targets) {
    if (targetDir === plan.bridge.bridgeDir) continue;
    generatedFiles.push(...writeAgentPair(targetDir, renderRepoDoc(targetDir, docs), repoFrontmatter(plan.bridge, docs)));
  }

  plan.warnings.push(...manageGeneratedGitState(generatedFiles));

  console.log(`Wrote bridge docs: ${join(formatPath(plan.bridge.bridgeDir), "CLAUDE.md")}, ${join(formatPath(plan.bridge.bridgeDir), "AGENTS.md")}`);
  if (shouldGenerateWorkspaceDocs(plan.bridge)) {
    console.log(`Wrote workspace docs: ${join(formatPath(plan.bridge.workspaceDir!), "CLAUDE.md")}, ${join(formatPath(plan.bridge.workspaceDir!), "AGENTS.md")}`);
  }
  console.log(`Wrote repo doc pairs: ${repoDocPairCount}`);
  if (plan.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of plan.warnings) console.log(`  - ${warning}`);
  }
}

function apply(args: string[]): void {
  if (args.includes("--dry-run")) {
    applyDryRun();
    return;
  }

  applyWrite();
}

// --- dispatch --------------------------------------------------------------

export function runCli(argv = process.argv.slice(2)): void {
  const [command, ...args] = argv;

  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(version);
      break;
    case "dump-backlog":
      dumpBacklog(args);
      break;
    case "apply":
      apply(args);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
}

function isEntrypoint(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  try {
    runCli();
  } catch (err) {
    if (err instanceof Error) console.error(`nosedive: ${err.message}`);
    else console.error(`nosedive: ${String(err)}`);
    process.exit(1);
  }
}
