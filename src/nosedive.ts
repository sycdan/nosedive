#!/usr/bin/env node
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `Usage: nosedive <command>

Commands:
  version       Print the package version
  dump-backlog  Print the open efforts under efforts/
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

function emptyYaml(): SimpleYaml {
  return { scalars: {}, lists: {}, nested: {} };
}

function cleanScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse the tiny YAML subset nosedive frontmatter and .nosediverc need. */
function parseSimpleYaml(block: string): SimpleYaml {
  const out = emptyYaml();
  let current: string | undefined;

  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const listItem = line.match(/^  -\s+(.*)$/);
    if (listItem && current) {
      out.lists[current] ??= [];
      out.lists[current].push(cleanScalar(listItem[1]));
      continue;
    }

    const nestedScalar = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nestedScalar && current) {
      out.nested[current] ??= {};
      out.nested[current][nestedScalar[1]] = cleanScalar(nestedScalar[2]);
      continue;
    }

    const scalar = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (scalar) {
      current = scalar[1];
      if (scalar[2].trim() !== "") out.scalars[current] = cleanScalar(scalar[2]);
    }
  }

  return out;
}

/** Parse leading `---` YAML frontmatter and return the body separately. */
function parseMarkdownDoc(text: string): MarkdownDoc {
  if (!text.startsWith("---")) return { fm: emptyYaml(), body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: emptyYaml(), body: text };
  const bodyStart = text.indexOf("\n", end + 4);
  return {
    fm: parseSimpleYaml(text.slice(3, end)),
    body: bodyStart === -1 ? "" : text.slice(bodyStart + 1),
  };
}

/** Parse leading `---` YAML frontmatter into a flat string map. */
function parseFrontmatter(text: string): Record<string, string> {
  return parseMarkdownDoc(text).fm.scalars;
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

// --- efforts ---------------------------------------------------------------

interface Effort {
  depth: number;
  chain: string; // slug chain, leaf-first, dot-joined
  phase: string;
  gist: string;
}

/** Walk one effort folder: emit it if open, then recurse into child folders. */
function walkEffort(dir: string, slug: string, ancestors: string[], out: Effort[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  const md = entries.find((e) => e.isFile() && e.name.endsWith(".md"));
  if (md) {
    // Presence under efforts/ means open; finished work leaves for kb/.
    const text = readFileSync(join(dir, md.name), "utf8");
    const fm = parseFrontmatter(text);
    out.push({
      depth: ancestors.length,
      chain: [slug, ...ancestors].join("."),
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

function dumpBacklog(): void {
  const efforts = collectEfforts(join(process.cwd(), "efforts"));
  if (efforts.length === 0) {
    console.log("No open efforts.");
    return;
  }
  // Fixed column where the slug chain starts, past the (indented) phase field.
  const col = Math.max(13, ...efforts.map((e) => e.depth * 2 + e.phase.length + 2));
  for (const e of efforts) {
    const prefix = " ".repeat(e.depth * 2) + e.phase;
    console.log(prefix.padEnd(col) + e.chain);
    if (e.gist) console.log(" ".repeat(col) + truncate(e.gist, 72));
  }
}

// --- apply -----------------------------------------------------------------

interface BridgeConfig {
  bridgeDir: string;
  workspaceDir: string;
  backlogDir: string;
  kbDir: string;
  effortPath: string;
  effortRef: string;
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
  render: "body" | "gist";
  scopePath: string;
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

function loadBridgeConfig(start: string): BridgeConfig {
  const rcPath = findBridgeConfig(start);
  if (!rcPath) throw new Error("not inside a nosedive bridge: no .nosediverc found");

  const bridgeDir = dirname(rcPath);
  const rc = parseSimpleYaml(readFileSync(rcPath, "utf8"));
  const workspace = rc.scalars.workspace;
  const backlog = rc.scalars.backlog;
  const kb = rc.scalars.kb;
  const effort = rc.nested.current?.effort;

  if (!workspace) throw new Error(".nosediverc is missing workspace");
  if (!backlog) throw new Error(".nosediverc is missing backlog");
  if (!kb) throw new Error(".nosediverc is missing kb");
  if (!effort) throw new Error(".nosediverc is missing current.effort");

  const backlogDir = resolveFrom(bridgeDir, backlog);
  return {
    bridgeDir,
    workspaceDir: resolveFrom(bridgeDir, workspace),
    backlogDir,
    kbDir: resolveFrom(bridgeDir, kb),
    effortPath: resolveFrom(backlogDir, effort),
    effortRef: effort,
  };
}

function parseEffortRepos(path: string): EffortRepo[] {
  const doc = parseMarkdownDoc(readFileSync(path, "utf8"));
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
      const doc = parseMarkdownDoc(readFileSync(path, "utf8"));
      return {
        path,
        relPath: relative(bridgeDir, path),
        id: doc.fm.scalars.id,
        kind: doc.fm.scalars.kind,
        gist: doc.fm.scalars.gist,
        repoPath: doc.fm.nested.meta?.path,
        scopes: doc.fm.lists.scopes ?? [],
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

function applyDryRun(): void {
  const bridge = loadBridgeConfig(process.cwd());
  assertDir(bridge.backlogDir, "backlog");
  assertDir(bridge.kbDir, "kb");
  if (!existsSync(bridge.effortPath)) throw new Error(`current effort does not exist: ${bridge.effortPath}`);

  const effortRepos = parseEffortRepos(bridge.effortPath);
  const selected = new Map(effortRepos.map((repo) => [repo.id, repo]));
  const kbDocs = loadKbDocs(bridge.kbDir, bridge.bridgeDir);
  const repoDocs = new Map(kbDocs.filter((doc) => doc.kind === "repo").map((doc) => [doc.id, doc]));
  const warnings: string[] = [];
  const targets = new Map<string, TargetDoc[]>();

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

    for (const doc of kbDocs) {
      if (doc.kind === "repo") continue;
      const renderDefault = defaultRender(doc.kind);
      if (!renderDefault) continue;

      for (const rawScope of doc.scopes) {
        const scope = parseScopeRef(rawScope);
        if (!scope || scope.repoId !== repo.id || !selected.has(scope.repoId)) continue;

        const targetDir = scope.path ? resolve(repoRoot, scope.path) : repoRoot;
        if (!existsSync(targetDir)) {
          warnings.push(`scope path does not exist; skipping ${doc.relPath} -> ${repoDoc.repoPath}/${scope.path}`);
          continue;
        }

        const render = scope.render ?? renderDefault;
        const list = targets.get(targetDir) ?? [];
        list.push({ doc, render, scopePath: scope.path });
        targets.set(targetDir, list);
      }
    }
  }

  console.log("nosedive apply --dry-run");
  console.log(`Bridge:    ${formatPath(bridge.bridgeDir)}`);
  console.log(`Workspace: ${formatPath(bridge.workspaceDir)}`);
  console.log(`Backlog:   ${formatPath(bridge.backlogDir)}`);
  console.log(`KB:        ${formatPath(bridge.kbDir)}`);
  console.log(`Effort:    ${bridge.effortRef}`);
  console.log("");

  console.log("Workspace docs:");
  console.log(`  ${join(formatPath(bridge.workspaceDir), "CLAUDE.md")}`);
  console.log(`  ${join(formatPath(bridge.workspaceDir), "AGENTS.md")}`);
  if (!existsSync(bridge.workspaceDir)) warnings.push(`workspace does not exist: ${bridge.workspaceDir}`);
  console.log("");

  console.log("Repos:");
  for (const repo of effortRepos) {
    const repoDoc = repoDocs.get(repo.id);
    const path = repoDoc?.repoPath ?? "(missing repo doc)";
    const mode = repo.readOnly ? "read-only" : "writable";
    console.log(`  ${mode.padEnd(9)} ${path} (${repo.id})`);
  }
  console.log("");

  console.log("Repo docs:");
  if (targets.size === 0) {
    console.log("  (none)");
  } else {
    for (const [targetDir, docs] of [...targets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
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

function apply(args: string[]): void {
  if (args.includes("--dry-run")) {
    applyDryRun();
    return;
  }

  throw new Error("write mode is not implemented yet; use `nosedive apply --dry-run`");
}

// --- dispatch --------------------------------------------------------------

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(version);
      break;
    case "dump-backlog":
      dumpBacklog();
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
} catch (err) {
  if (err instanceof Error) console.error(`nosedive: ${err.message}`);
  else console.error(`nosedive: ${String(err)}`);
  process.exit(1);
}
