#!/usr/bin/env node
import { createRequire } from "node:module";
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const USAGE = `Usage: nosedive <command>

Commands:
  version       Print the package version
  dump-backlog  Print the open efforts under efforts/
`;

// --- frontmatter -----------------------------------------------------------

/** Parse leading `---` YAML frontmatter into a flat string map (scalars only). */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return out;
  const block = text.slice(3, end);
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** First paragraph of the `## Goal` section, collapsed to one line. */
function goalGist(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^##\s+Goal\s*$/.test(l));
  if (start === -1) return "";
  const para: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === "" && para.length === 0) continue; // skip blanks before the text
    if (l === "" || l.startsWith("#")) break; // paragraph / section end
    para.push(l);
  }
  return para.join(" ").replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

// --- efforts ---------------------------------------------------------------

interface Effort {
  depth: number;
  chain: string; // slug chain, leaf-first, dot-joined
  status: string;
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
      status: fm.status || "unknown",
      gist: goalGist(text),
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
    return out; // missing efforts/ dir → empty backlog
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
  // Fixed column where the slug chain starts, past the (indented) status field.
  const col = Math.max(13, ...efforts.map((e) => e.depth * 2 + e.status.length + 2));
  for (const e of efforts) {
    const prefix = " ".repeat(e.depth * 2) + e.status;
    console.log(prefix.padEnd(col) + e.chain);
    if (e.gist) console.log(" ".repeat(col) + truncate(e.gist, 72));
  }
}

// --- dispatch --------------------------------------------------------------

const [command] = process.argv.slice(2);

switch (command) {
  case "version":
  case "--version":
  case "-v":
    console.log(version);
    break;
  case "dump-backlog":
    dumpBacklog();
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
