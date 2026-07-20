import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
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
import { isSeq, parse as parseYaml, parseDocument } from "yaml";

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
  mint          Generate UUIDv7 with a specific timestamp encoded
  init          Create or edit .nosediverc interactively
  dump-backlog  Print the open efforts in the configured backlog
  pitch         Create a new effort in the backlog
  add-repo      Add a kb repo to an effort's workspace
  apply         Materialize scoped agent docs for the current effort
`;

const KNOWN_AGENTS = ["copilot", "claude"];

const DEFAULT_RC = {
  workspace: "./workspace",
  backlog: "./backlog",
  kb: "./kb",
  sessions: "./sessions",
  "home-branch": "main",
  "work-branch-prefix": "work/",
  agents: ["copilot"],
};

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

interface MarkdownFrontmatterBlock {
  yaml: string;
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
  agents: string[];
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

function splitMarkdownFrontmatter(text: string, label = "markdown document"): MarkdownFrontmatterBlock {
  if (!text.startsWith("---")) throw new Error(`${label} is missing YAML frontmatter`);
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new Error(`${label} has unterminated YAML frontmatter`);
  const bodyStart = text.indexOf("\n", end + 4);
  return {
    yaml: text.slice(3, end),
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
    agents: rc.lists.agents && rc.lists.agents.length > 0 ? rc.lists.agents : [...DEFAULT_RC.agents],
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

// --- init --------------------------------------------------------------

interface RcSettings {
  workspace: string;
  backlog: string;
  kb: string;
  sessions: string;
  homeBranch: string;
  workBranchPrefix: string;
  agents: string[];
}

function loadRcSettings(rcPath: string): RcSettings {
  if (!existsSync(rcPath)) {
    return {
      workspace: DEFAULT_RC.workspace,
      backlog: DEFAULT_RC.backlog,
      kb: DEFAULT_RC.kb,
      sessions: DEFAULT_RC.sessions,
      homeBranch: DEFAULT_RC["home-branch"],
      workBranchPrefix: DEFAULT_RC["work-branch-prefix"],
      agents: [...DEFAULT_RC.agents],
    };
  }

  const rc = parseYamlBlock(readFileSync(rcPath, "utf8"), rcPath);
  return {
    workspace: rc.scalars.workspace ?? DEFAULT_RC.workspace,
    backlog: rc.scalars.backlog ?? DEFAULT_RC.backlog,
    kb: rc.scalars.kb ?? DEFAULT_RC.kb,
    sessions: rc.scalars.sessions ?? DEFAULT_RC.sessions,
    homeBranch: rc.scalars["home-branch"] ?? DEFAULT_RC["home-branch"],
    workBranchPrefix: rc.scalars["work-branch-prefix"] ?? DEFAULT_RC["work-branch-prefix"],
    agents: rc.lists.agents && rc.lists.agents.length > 0 ? rc.lists.agents : [...DEFAULT_RC.agents],
  };
}

type LineIterator = NodeJS.AsyncIterator<string>;

/**
 * Piped (non-TTY) stdin delivers every buffered line the instant the stream
 * is first resumed, but `rl.question()` only ever attaches a listener for
 * one line at a time -- every line after the first gets silently dropped,
 * and the next question then hangs waiting on an already-EOF'd stream.
 * Driving the interface's async iterator directly instead consumes lines
 * one at a time regardless of how they arrived.
 */
async function nextLine(iter: LineIterator): Promise<string | undefined> {
  const { value, done } = await iter.next();
  return done ? undefined : value.trim();
}

async function promptScalar(iter: LineIterator, label: string, current: string): Promise<string> {
  process.stdout.write(`${label} [${current}]: `);
  const line = await nextLine(iter);
  return !line ? current : line;
}

async function promptAgents(iter: LineIterator, current: string[]): Promise<string[]> {
  for (;;) {
    process.stdout.write(`agents, comma-separated (options: ${KNOWN_AGENTS.join(", ")}) [${current.join(",")}]: `);
    const line = await nextLine(iter);
    if (line === undefined) return current;
    const list = line === "" ? current : line.split(",").map((entry) => entry.trim()).filter(Boolean);
    const unknown = list.filter((agent) => !KNOWN_AGENTS.includes(agent));
    if (unknown.length > 0) {
      console.error(`unknown agent(s): ${unknown.join(", ")} (options: ${KNOWN_AGENTS.join(", ")})`);
      continue;
    }
    if (list.length === 0) {
      console.error("select at least one agent");
      continue;
    }
    return list;
  }
}

function renderRc(settings: RcSettings): string {
  return [
    `workspace: ${settings.workspace}`,
    `backlog: ${settings.backlog}`,
    `kb: ${settings.kb}`,
    `sessions: ${settings.sessions}`,
    `home-branch: ${settings.homeBranch}`,
    `work-branch-prefix: ${settings.workBranchPrefix}`,
    `agents:`,
    ...settings.agents.map((agent) => `  - ${agent}`),
    "",
  ].join("\n");
}

async function init(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    console.log("Usage: nosedive init");
    console.log("  Create or edit .nosediverc in the current directory, prompting for each setting.");
    console.log("  Existing values (or built-in defaults) are shown as the default for each prompt; press Enter to keep it.");
    return;
  }

  const rcPath = join(process.cwd(), ".nosediverc");
  const settings = loadRcSettings(rcPath);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const iter = rl[Symbol.asyncIterator]();
    settings.workspace = await promptScalar(iter, "workspace", settings.workspace);
    settings.backlog = await promptScalar(iter, "backlog", settings.backlog);
    settings.kb = await promptScalar(iter, "kb", settings.kb);
    settings.sessions = await promptScalar(iter, "sessions", settings.sessions);
    settings.homeBranch = await promptScalar(iter, "home-branch", settings.homeBranch);
    settings.workBranchPrefix = await promptScalar(iter, "work-branch-prefix", settings.workBranchPrefix);
    settings.agents = await promptAgents(iter, settings.agents);
  } finally {
    rl.close();
  }

  writeFileAtomic(rcPath, renderRc(settings));
  console.log(`Wrote ${formatPath(rcPath)}`);
}

// --- efforts ---------------------------------------------------------------

interface Effort {
  depth: number;
  chain: string; // slug chain, leaf-first, dot-joined
  path: string;
  phase: string;
  gist: string;
}

interface BacklogNode {
  slug: string;
  effort?: Effort;
  children: BacklogNode[];
}

interface BacklogConfig {
  bridgeDir: string;
  backlogDir: string;
}

function effortMarkdownInDir(dir: string, slug: string): string | undefined {
  const expected = join(dir, `${pascalFromSlug(slug)}.md`);
  return existsSync(expected) ? expected : undefined;
}

/** Walk one backlog directory, preserving non-effort domain directories. */
function walkBacklogNode(dir: string, slug: string, ancestors: string[]): BacklogNode | undefined {
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

function collectBacklog(effortsDir: string): BacklogNode[] {
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

function flattenEfforts(nodes: BacklogNode[]): Effort[] {
  return nodes.flatMap((node) => [...(node.effort ? [node.effort] : []), ...flattenEfforts(node.children)]);
}

function collectEfforts(effortsDir: string): Effort[] {
  return flattenEfforts(collectBacklog(effortsDir));
}

function loadBacklogConfig(start: string): BacklogConfig {
  const rc = readNosediveRc(start);

  if (!rc.backlogDir) throw new Error(".nosediverc is missing backlog");
  return { bridgeDir: rc.bridgeDir, backlogDir: rc.backlogDir };
}

function treeChars(): { tee: string; elbow: string; pipe: string; blank: string } {
  if (process.env.NOSEDIVE_ASCII_TREE === "1") {
    return { tee: "|- ", elbow: "`- ", pipe: "|  ", blank: "   " };
  }
  return { tee: "├─ ", elbow: "└─ ", pipe: "│  ", blank: "   " };
}

function formatBacklogNode(node: BacklogNode, prefix: string, last: boolean, verbose: boolean, lines: string[], tree = treeChars()): void {
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
  node.children.forEach((child, index) => formatBacklogNode(child, childPrefix, index === node.children.length - 1, verbose, lines, tree));
}

function formatBacklog(nodes: BacklogNode[], verbose: boolean): string {
  if (nodes.length === 0) {
    return "No open efforts.";
  }

  const lines: string[] = [];
  const tree = treeChars();
  nodes.forEach((node, index) => formatBacklogNode(node, "", index === nodes.length - 1, verbose, lines, tree));
  return lines.join("\n");
}

function dumpBacklog(args: string[]): void {
  const verbose = args.includes("--verbose");
  const unknown = args.filter((arg) => arg !== "--verbose");
  if (unknown.length > 0) throw new Error(`unknown dump-backlog option: ${unknown[0]}`);

  const { backlogDir } = loadBacklogConfig(process.cwd());
  console.log(formatBacklog(collectBacklog(backlogDir), verbose));
}

function pascalFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("");
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function assertSlug(slug: string, label: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`${label} must be kebab-case: ${slug}`);
  }
  return slug;
}

function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertEffortDirInsideBacklog(path: string, backlogDir: string, label: string): string {
  const dir = resolve(path);
  if (!isInsideDir(backlogDir, dir)) throw new Error(`${label} is outside backlog: ${path}`);
  const effortFile = effortMarkdownInDir(dir, dir.split(/[\\/]/).at(-1) ?? "");
  if (!effortFile) throw new Error(`${label} is not an effort directory: ${path}`);
  return dir;
}

function assertBacklogDir(path: string, backlogDir: string, label: string): string {
  const dir = resolve(path);
  if (!isInsideDir(backlogDir, dir)) throw new Error(`${label} is outside backlog: ${path}`);
  return dir;
}

function resolveParentDir(parentRef: string, bridgeDir: string, backlogDir: string): string {
  const pathCandidates = [
    isAbsolute(parentRef) ? resolve(parentRef) : undefined,
    resolve(bridgeDir, parentRef),
    resolve(backlogDir, parentRef),
  ].filter((candidate): candidate is string => candidate !== undefined);

  for (const candidate of pathCandidates) {
    if (!existsSync(candidate)) continue;
    const stats = statSync(candidate);
    if (stats.isFile()) {
      if (!candidate.endsWith(".md")) throw new Error(`parent path is not an effort markdown file: ${parentRef}`);
      const dir = dirname(candidate);
      if (!isInsideDir(backlogDir, dir)) throw new Error(`parent path is outside backlog: ${parentRef}`);
      return assertEffortDirInsideBacklog(dir, backlogDir, `parent path ${parentRef}`);
    }
    if (stats.isDirectory()) return assertBacklogDir(candidate, backlogDir, `parent path ${parentRef}`);
  }

  const matches = collectEfforts(backlogDir).filter((effort) => effort.chain === parentRef);
  if (matches.length === 1) return dirname(matches[0]!.path);
  if (matches.length > 1) throw new Error(`parent effort is ambiguous: ${parentRef}`);
  throw new Error(`parent effort not found: ${parentRef}`);
}

function resolveEffortPath(effortRef: string, bridgeDir: string, backlogDir: string, label = "effort"): string {
  const pathCandidates = [
    isAbsolute(effortRef) ? resolve(effortRef) : undefined,
    resolve(process.cwd(), effortRef),
    resolve(bridgeDir, effortRef),
    resolve(backlogDir, effortRef),
  ].filter((candidate): candidate is string => candidate !== undefined);

  for (const candidate of pathCandidates) {
    if (!existsSync(candidate)) continue;
    const stats = statSync(candidate);
    if (stats.isFile()) {
      if (!candidate.endsWith(".md")) throw new Error(`${label} path is not an effort markdown file: ${effortRef}`);
      if (!isInsideDir(backlogDir, candidate)) throw new Error(`${label} path is outside backlog: ${effortRef}`);
      return candidate;
    }
    if (stats.isDirectory()) {
      const dir = assertEffortDirInsideBacklog(candidate, backlogDir, `${label} path ${effortRef}`);
      const slug = dir.split(/[\\/]/).at(-1) ?? "";
      return join(dir, `${pascalFromSlug(slug)}.md`);
    }
  }

  const matches = collectEfforts(backlogDir).filter((effort) => effort.chain === effortRef);
  if (matches.length === 1) return matches[0]!.path;
  if (matches.length > 1) throw new Error(`${label} is ambiguous: ${effortRef}`);
  throw new Error(`${label} not found: ${effortRef}`);
}

function effortRefFromPath(effortPath: string, backlogDir: string): string {
  return relative(backlogDir, effortPath).replaceAll("\\", "/");
}

function parsePitchArgs(args: string[]): { slug: string; gist: string; pitch: string; parent?: string } {
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
      if (!parent) throw new Error("--parent requires an effort or namespace path, or an effort slug chain");
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

function renderPitchedEffort(slug: string, gist: string, pitchText: string): string {
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

function pitch(args: string[]): void {
  const { slug, gist, pitch: pitchText, parent } = parsePitchArgs(args);
  const { bridgeDir, backlogDir } = loadBacklogConfig(process.cwd());
  const parentDir = parent ? resolveParentDir(parent, bridgeDir, backlogDir) : backlogDir;
  if (!existsSync(backlogDir)) mkdirSync(backlogDir, { recursive: true });

  const effortDir = join(parentDir, slug);
  if (existsSync(effortDir)) throw new Error(`effort already exists: ${formatPath(effortDir)}`);
  const effortPath = join(effortDir, `${pascalFromSlug(slug)}.md`);
  writeFileAtomic(effortPath, renderPitchedEffort(slug, gist, pitchText));

  console.log(`Pitched ${formatPath(effortPath)}`);
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
  ref?: string;
  readOnly: boolean;
}

interface KbDoc {
  path: string;
  relPath: string;
  id: string;
  name: string;
  kind: string;
  gist: string;
  repoPath?: string;
  repoBaseBranch?: string;
  scopes: string[];
}

interface ScopeRef {
  repoId: string;
  path: string;
  ref?: string;
  readOnly: boolean;
  flags: string[];
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
  repos: Array<EffortRepo & { repoPath?: string; repoBaseBranch: string; repoRef: string }>;
  targets: Map<string, TargetDoc[]>;
  warnings: string[];
}

function currentDeveloperId(bridgeDir: string): string | undefined {
  return gitOutput(bridgeDir, ["config", "user.email"]) || gitOutput(bridgeDir, ["config", "user.name"]);
}

function heldDiveEffortRefs(rc: NosediveRc): string[] {
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

function activeEffortRefFromHeldDive(rc: NosediveRc): string | undefined {
  if (!rc.backlogDir) return undefined;
  const held = heldDiveEffortRefs(rc);
  if (held.length === 0) return undefined;
  if (held.length > 1) throw new Error(`developer has more than one held dive: ${held.join(", ")}`);
  return effortRefFromPath(resolveEffortPath(held[0]!, rc.bridgeDir, rc.backlogDir, "held dive effort"), rc.backlogDir);
}

function loadBridgeConfig(start: string): BridgeConfig {
  const rc = readNosediveRc(start);
  const effort = rc.current.effort ?? activeEffortRefFromHeldDive(rc);

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
  return (doc.fm.lists.repos ?? []).map((rawEntry) => {
    const entry = rawEntry.trim();
    if (!entry) throw new Error(`invalid effort repo entry in ${path}: empty value`);

    const firstColon = entry.indexOf(":");
    const secondColon = firstColon === -1 ? -1 : entry.indexOf(":", firstColon + 1);
    if (secondColon !== -1) {
      throw new Error(`invalid effort repo entry in ${path}: ${entry} (expected <repo-id>[@ref][:flags])`);
    }

    const base = firstColon === -1 ? entry : entry.slice(0, firstColon);
    const flagText = firstColon === -1 ? "" : entry.slice(firstColon + 1);
    if (!base) throw new Error(`invalid effort repo entry in ${path}: ${entry} (missing repo id)`);

    let readOnly = false;
    if (firstColon !== -1) {
      if (!flagText) throw new Error(`invalid effort repo entry in ${path}: ${entry} (missing flags after :)`);
      for (const flag of flagText.split(",").map((item) => item.trim())) {
        if (!flag) throw new Error(`invalid effort repo entry in ${path}: ${entry} (empty flag)`);
        if (flag === "ro") {
          readOnly = true;
          continue;
        }
        throw new Error(`invalid effort repo flag in ${path}: ${entry} (unsupported flag: ${flag})`);
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
    if (at !== -1 && !ref) throw new Error(`invalid effort repo entry in ${path}: ${entry} (missing ref after @)`);

    return { id, ref, readOnly };
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
        name: fm.scalars.name,
        kind: fm.scalars.kind,
        gist: fm.scalars.gist,
        repoPath: fm.nested.meta?.path,
        repoBaseBranch: fm.nested.meta?.["base-branch"],
        scopes: fm.lists.scopes ?? [],
      };
    });
}

interface AddRepoOptions {
  repoRef: string;
  effortRef?: string;
  repoEntryRef?: string;
  readOnly: boolean;
  apply: boolean;
}

function parseAddRepoArgs(args: string[]): AddRepoOptions {
  let repoRef: string | undefined;
  let effortRef: string | undefined;
  let repoEntryRef: string | undefined;
  let readOnly = false;
  let shouldApply = true;

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

function repoDocs(kbDocs: KbDoc[]): KbDoc[] {
  return kbDocs.filter((doc) => doc.kind === "repo");
}

function resolveRepoDoc(kbDocs: KbDoc[], repoRef: string): KbDoc {
  const byId = repoDocs(kbDocs).filter((doc) => doc.id === repoRef);
  if (byId.length === 1) return byId[0]!;

  const byName = repoDocs(kbDocs).filter((doc) => doc.name === repoRef);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(`repo name is ambiguous: ${repoRef} (${byName.map((doc) => doc.id).join(", ")})`);
  }
  throw new Error(`repo not found: ${repoRef}`);
}

function formatEffortRepoEntry(repoId: string, ref: string | undefined, readOnly: boolean): string {
  return `${repoId}${ref ? `@${ref}` : ""}${readOnly ? ":ro" : ""}`;
}

function appendRepoToEffort(path: string, repo: EffortRepo): string {
  const existing = parseEffortRepos(path);
  if (existing.some((entry) => entry.id === repo.id)) throw new Error(`effort already includes repo ${repo.id}: ${formatPath(path)}`);

  const text = readFileSync(path, "utf8");
  const frontmatter = splitMarkdownFrontmatter(text, path);
  const entry = formatEffortRepoEntry(repo.id, repo.ref, repo.readOnly);
  const doc = parseDocument(frontmatter.yaml);
  if (doc.errors.length > 0) throw new Error(`invalid YAML in frontmatter in ${path}: ${doc.errors[0]?.message ?? "unknown error"}`);

  const repos = doc.get("repos", true);
  if (repos === undefined || repos === null) {
    doc.set("repos", [entry]);
  } else if (isSeq(repos)) {
    repos.add(entry);
  } else {
    throw new Error(`invalid effort repos in ${path}: expected a YAML list`);
  }

  const yaml = doc.toString({ lineWidth: 0 });
  writeFileAtomic(path, ["---", yaml.trimEnd(), "---", frontmatter.body].join("\n"));
  return entry;
}

function activeEffortPath(rc: NosediveRc): string | undefined {
  if (!rc.backlogDir) return undefined;
  const effortRef = rc.current.effort ?? activeEffortRefFromHeldDive(rc);
  return effortRef ? resolveEffortPath(effortRef, rc.bridgeDir, rc.backlogDir, "active effort") : undefined;
}

function resolveAddRepoEffort(rc: NosediveRc, options: AddRepoOptions): { path: string; active: boolean } {
  if (!rc.backlogDir) throw new Error(".nosediverc is missing backlog");

  const activePath = activeEffortPath(rc);
  if (options.effortRef) {
    const explicitPath = resolveEffortPath(options.effortRef, rc.bridgeDir, rc.backlogDir, "effort");
    return { path: explicitPath, active: activePath === explicitPath };
  }
  if (!activePath) throw new Error("add-repo requires --effort when no held dive or current effort is active");
  return { path: activePath, active: true };
}

function addRepo(args: string[]): void {
  const options = parseAddRepoArgs(args);
  const rc = readNosediveRc(process.cwd());
  if (!rc.kbDir) throw new Error(".nosediverc is missing kb");

  const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
  const repoDoc = resolveRepoDoc(kbDocs, options.repoRef);
  const effort = resolveAddRepoEffort(rc, options);
  appendRepoToEffort(effort.path, { id: repoDoc.id, ref: options.repoEntryRef, readOnly: options.readOnly });

  console.log(`Added ${repoDoc.id} to ${formatPath(effort.path)}`);

  if (options.apply && effort.active && rc.workspaceDir) {
    applyWrite();
  } else if (options.apply && !effort.active) {
    console.log("Generated docs not updated because the target effort is not active.");
  }
}

function parseScopeRef(scope: string): ScopeRef | undefined {
  const colon = scope.indexOf(":");
  const targetAndRef = colon === -1 ? scope : scope.slice(0, colon);
  const flagText = colon === -1 ? "" : scope.slice(colon + 1);
  if (flagText.includes(":")) return undefined;
  const flags =
    colon === -1
      ? []
      : flagText
        .split(",")
        .map((flag) => flag.trim())
        .filter(Boolean);
  let render: "body" | "gist" | undefined;

  for (const flag of flags) {
    if (flag === "body" || flag === "gist") render = flag;
  }

  const at = targetAndRef.indexOf("@");
  const target = at === -1 ? targetAndRef : targetAndRef.slice(0, at);
  const ref = at === -1 ? undefined : targetAndRef.slice(at + 1);
  const slash = target.indexOf("/");
  const repoId = slash === -1 ? target : target.slice(0, slash);
  const path = slash === -1 ? "" : target.slice(slash + 1);
  if (!repoId) return undefined;
  return { repoId, path, ref, readOnly: flags.includes("ro"), flags, render };
}

function defaultRender(kind: string): "body" | "gist" | undefined {
  if (kind === "foundation") return "body";
  if (kind === "convention" || kind === "skill" || kind === "runbook" || kind === "assertion" || kind === "decision") return "gist";
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

function bridgeRunbookDocs(kbDocs: KbDoc[]): KbDoc[] {
  return kbDocs.filter((doc) => doc.kind === "runbook" && doc.scopes.some((scope) => scope.trim() === "."));
}

function createApplyPlan(): ApplyPlan {
  const bridge = loadBridgeConfig(process.cwd());
  assertDir(bridge.kbDir, "kb");
  const kbDocs = loadKbDocs(bridge.kbDir, bridge.bridgeDir);
  const repoDocs = new Map(kbDocs.filter((doc) => doc.kind === "repo").map((doc) => [doc.id, doc]));
  const warnings: string[] = [];
  const targets = new Map<string, TargetDoc[]>();
  let repos: Array<EffortRepo & { repoPath?: string; repoBaseBranch: string; repoRef: string }> = [];

  const foundationDocs = kbDocs.filter((doc) => doc.kind === "foundation");
  targets.set(
    bridge.bridgeDir,
    [
      ...foundationDocs.map((doc) => ({ doc, repoId: "", render: "body" as const, scopePath: "", readOnly: false })),
      ...bridgeRunbookDocs(kbDocs).map((doc) => ({ doc, repoId: "", render: "gist" as const, scopePath: ".", readOnly: false })),
    ],
  );

  if (shouldGenerateWorkspaceDocs(bridge)) {
    assertDir(bridge.backlogDir!, "backlog");
    if (!existsSync(bridge.effortPath!)) throw new Error(`current effort does not exist: ${bridge.effortPath}`);

    const effortRepos = parseEffortRepos(bridge.effortPath!);
    repos = effortRepos.map((repo) => {
      const repoDoc = repoDocs.get(repo.id);
      const repoBaseBranch = repoDoc?.repoBaseBranch ?? "main";
      return { ...repo, repoPath: repoDoc?.repoPath, repoBaseBranch, repoRef: repo.ref ?? repoBaseBranch };
    });

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
      const refSummary = repo.ref ? `ref ${repo.repoRef} (base ${repo.repoBaseBranch})` : `base ${repo.repoBaseBranch}`;
      console.log(`  ${mode.padEnd(9)} ${path} (${repo.id}, ${refSummary})`);
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

function renderGistBlock(doc: KbDoc): string {
  const title = doc.id ? `${doc.kind || "doc"} ${doc.id}` : doc.relPath;
  return [`## ${title}`, "", doc.gist || "(no gist)", "", `Source: \`${doc.relPath}\``, ""].join("\n");
}

function renderRunbookGistBlock(doc: KbDoc): string {
  const title = doc.name || doc.id || doc.relPath;
  return [`### \`${title}\``, "", doc.gist || "(no gist)", "", `Source: \`${doc.relPath}\``, ""].join("\n");
}

function renderBodyBlock(doc: KbDoc): string {
  const body = parseMarkdownDoc(readFileSync(doc.path, "utf8"), doc.path).body.trim();
  return [`<!-- Source: ${doc.relPath} -->`, "", body, ""].join("\n");
}

function renderRepoDoc(targetDir: string, docs: TargetDoc[]): string {
  const readOnly = docs.some((item) => item.readOnly);
  const sortedDocs = docs.sort((a, b) => a.doc.relPath.localeCompare(b.doc.relPath));
  const runbookItems = sortedDocs
    .filter((item) => item.render === "gist" && item.doc.kind === "runbook")
    .sort((a, b) => a.doc.name.localeCompare(b.doc.name));
  const nonRunbookBlocks = sortedDocs
    .filter((item) => item.doc.kind !== "runbook")
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

function parseMintTimestamp(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  return Date.parse(value);
}

const UUID7_MAX_TIMESTAMP_MS = 0xffffffffffff;

function uuid7AtMs(ms: number): string {
  const bytes = new Uint8Array(require("node:crypto").randomBytes(16)) as Uint8Array;
  const ts = BigInt(ms);

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // Set version (0111) and variant (10).
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

function mintId(args: string[]): void {
  const [firstArg, secondArg] = args;
  if (firstArg === "-h" || firstArg === "--help") {
    console.log("Usage: nosedive mint [timestamp] [count]");
    console.log("  [timestamp]: ISO date string or Unix milliseconds (default: now)");
    console.log("  [count]: integer from 1 to 1000 (default: 1, one UUID per successive ms)");
    return;
  }

  const baseMs = firstArg ? parseMintTimestamp(firstArg) : Date.now();
  const count = secondArg ? Number(secondArg) : 1;

  if (!Number.isFinite(baseMs) || baseMs < 0 || !Number.isInteger(baseMs)) {
    throw new Error("mint: invalid timestamp (use ISO date string or Unix milliseconds)");
  }
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error("mint: invalid count (must be an integer between 1 and 1000)");
  }
  if (baseMs > UUID7_MAX_TIMESTAMP_MS || baseMs + (count - 1) > UUID7_MAX_TIMESTAMP_MS) {
    throw new Error("mint: timestamp out of UUIDv7 range");
  }

  for (let i = 0; i < count; i += 1) console.log(uuid7AtMs(baseMs + i));
}

// --- dispatch --------------------------------------------------------------

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;

  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(version);
      break;
    case "mint":
      mintId(args);
      break;
    case "init":
      await init(args);
      break;
    case "dump-backlog":
      dumpBacklog(args);
      break;
    case "pitch":
      pitch(args);
      break;
    case "add-repo":
      addRepo(args);
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
