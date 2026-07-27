import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import * as nodePath from "node:path";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	existsSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	readdirSync,
	readFileSync,
	rmSync,
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
const FOUNDATION_EXCLUDE_BEGIN = "# BEGIN nosedive-managed package-foundation exclude";
const FOUNDATION_EXCLUDE_END = "# END nosedive-managed package-foundation exclude";
const REPO_MARKER_EXCLUDE_BEGIN = "# BEGIN nosedive-managed repo-marker exclude";
const REPO_MARKER_EXCLUDE_END = "# END nosedive-managed repo-marker exclude";
const PRE_PUSH_HOOK = '#!/bin/sh\n# nosedive-managed\nexec npx nosedive pre-push.hook "$@"\n';
const MANUAL_PRE_PUSH_LINE = 'npx nosedive pre-push.hook "$@" || exit 1';
const HANDOFF_RUNBOOK_ID = "019f9f95-750a-7b26-a53e-6c277e8f148f";
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
  preflight     Install the bridge pre-push hook
  prove         Run an assertion prover
  render        Print a packaged kb document body by uuid
  pre-push.hook Run bridge pre-push checks
  whoami        Print the bridge pilot identity
  dump-backlog  Print the open efforts in the configured backlog
  list-dives    Print pickupable and working dives for an effort
  pitch         Create a new effort in the backlog
  hydrate-repo.workspace  Hydrate one repo worktree from kb metadata
  dehydrate-repo.workspace  Remove one hydrated repo worktree from the workspace
  add-repo      Add a kb repo to an effort's workspace
  apply         Materialize scoped agent docs for the current effort
  nuke          Reset managed local git state
`;

const KNOWN_AGENTS = ["copilot", "claude"];
const AGENT_FILENAMES: Record<string, string> = {
	copilot: "AGENTS.md",
	claude: "CLAUDE.md",
};

const DEFAULT_RC = {
	workspace: "./workspace",
	backlog: "./backlog",
	kb: "./kb",
	"home-branch": "main",
	"work-branch-prefix": "work/",
	agents: ["copilot"],
};

// --- bridge config shape -----------------------------------------------

const SPLIT_CONFIG_DIRNAME = ".nosedive";
const BASE_CONFIG_FILENAME = "config.yaml";
const LOCAL_CONFIG_FILENAME = ".nosedive.local.yaml";
const LEGACY_CONFIG_FILENAME = ".nosediverc";
const MIGRATION_BACKUP_DIRNAME = "migration-backups";

/** Schema version a freshly-migrated or freshly-init'd bridge ends up on. */
const CURRENT_SCHEMA_VERSION = 1;

const BASE_CONFIG_KNOWN_KEYS = [
	"schema-version",
	"workspace",
	"backlog",
	"kb",
	"home-branch",
	"work-branch-prefix",
	"agents",
] as const;

const LOCAL_CONFIG_KNOWN_KEYS = ["pilot-name", "pilot-email"] as const;

// --- frontmatter -----------------------------------------------------------

interface SimpleYaml {
	raw: Record<string, unknown>;
	scalars: Record<string, string>;
	lists: Record<string, string[]>;
	nested: Record<string, Record<string, string>>;
	nestedLists: Record<string, Record<string, string[]>>;
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
	homeBranch?: string;
	workBranchPrefix?: string;
	pilotName?: string;
	pilotEmail?: string;
	agents: string[];
	current: {
		effort?: string;
	};
}

export interface NosediveRcCurrent {
	effort?: string;
}

function emptyYaml(): SimpleYaml {
	return { raw: {}, scalars: {}, lists: {}, nested: {}, nestedLists: {} };
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

function splitMarkdownFrontmatter(
	text: string,
	label = "markdown document",
): MarkdownFrontmatterBlock {
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

function baseConfigPath(bridgeDir: string): string {
	return join(bridgeDir, SPLIT_CONFIG_DIRNAME, BASE_CONFIG_FILENAME);
}

function localConfigPath(bridgeDir: string): string {
	return join(bridgeDir, LOCAL_CONFIG_FILENAME);
}

function legacyConfigPath(bridgeDir: string): string {
	return join(bridgeDir, LEGACY_CONFIG_FILENAME);
}

type ResolvedBridgeConfig =
	| { shape: "split"; bridgeDir: string; basePath: string; localPath: string }
	| { shape: "legacy"; bridgeDir: string; legacyPath: string };

/**
 * Walk upward from `start` looking for bridge config. Split-shape
 * (`.nosedive/config.yaml`) takes priority over legacy (`.nosediverc`) at
 * each directory, so a bridge mid-migration can't be shadowed by a stale
 * legacy file left one level up.
 */
function findBridgeConfig(start: string): ResolvedBridgeConfig | undefined {
	let dir = resolve(start);
	for (;;) {
		const basePath = baseConfigPath(dir);
		if (existsSync(basePath))
			return { shape: "split", bridgeDir: dir, basePath, localPath: localConfigPath(dir) };
		const legacyPath = legacyConfigPath(dir);
		if (existsSync(legacyPath)) return { shape: "legacy", bridgeDir: dir, legacyPath };
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function noBridgeConfigError(): Error {
	return new Error(
		`not inside a nosedive bridge: no ${SPLIT_CONFIG_DIRNAME}/${BASE_CONFIG_FILENAME} or ${LEGACY_CONFIG_FILENAME} found`,
	);
}

/** Merge base config with personal local overrides; local wins on conflicts. */
function readSplitEffectiveYaml(basePath: string, localPath: string): SimpleYaml {
	const base = parseYamlBlock(readFileSync(basePath, "utf8"), basePath);
	const local = existsSync(localPath)
		? parseYamlBlock(readFileSync(localPath, "utf8"), localPath)
		: emptyYaml();
	return {
		raw: { ...base.raw, ...local.raw },
		scalars: { ...base.scalars, ...local.scalars },
		lists: { ...base.lists, ...local.lists },
		nested: { ...base.nested, ...local.nested },
		nestedLists: { ...base.nestedLists, ...local.nestedLists },
	};
}

export function readNosediveRc(start: string): NosediveRc {
	const resolved = findBridgeConfig(start);
	if (!resolved) throw noBridgeConfigError();

	const bridgeDir = resolved.bridgeDir;
	const rc =
		resolved.shape === "split"
			? readSplitEffectiveYaml(resolved.basePath, resolved.localPath)
			: parseYamlBlock(readFileSync(resolved.legacyPath, "utf8"), resolved.legacyPath);
	const workspace = rc.scalars.workspace;
	const backlog = rc.scalars.backlog;
	const kb = rc.scalars.kb;

	return {
		path: resolved.shape === "split" ? resolved.basePath : resolved.legacyPath,
		bridgeDir,
		workspaceDir: workspace ? resolveFrom(bridgeDir, workspace) : undefined,
		backlogDir: backlog ? resolveFrom(bridgeDir, backlog) : undefined,
		kbDir: kb ? resolveFrom(bridgeDir, kb) : undefined,
		homeBranch: rc.scalars["home-branch"],
		workBranchPrefix: rc.scalars["work-branch-prefix"],
		pilotName: rc.scalars["pilot-name"],
		pilotEmail: rc.scalars["pilot-email"],
		agents:
			rc.lists.agents && rc.lists.agents.length > 0 ? rc.lists.agents : [...DEFAULT_RC.agents],
		current: {
			effort: rc.nested.current?.effort,
		},
	};
}

export function writeNosediveRcCurrent(start: string, current?: NosediveRcCurrent): void {
	const resolved = findBridgeConfig(start);
	if (!resolved) throw noBridgeConfigError();

	// `current.*` is transient per-developer state, so it belongs in the
	// personal local file on a split bridge, and in the single file on a
	// legacy one.
	const targetPath = resolved.shape === "split" ? resolved.localPath : resolved.legacyPath;
	const doc = parseDocument(existsSync(targetPath) ? readFileSync(targetPath, "utf8") : "");
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in ${targetPath}: ${doc.errors[0]?.message ?? "unknown error"}`);

	if (!current?.effort) {
		doc.deleteIn(["current"]);
	} else {
		doc.setIn(["current", "effort"], current.effort ?? null);
		if (!current.effort) doc.deleteIn(["current", "effort"]);
	}

	writeFileAtomic(targetPath, doc.toString());
}

// --- init --------------------------------------------------------------

interface RcSettings {
	workspace: string;
	backlog: string;
	kb: string;
	homeBranch: string;
	workBranchPrefix: string;
	pilotName: string;
	pilotEmail: string;
	agents: string[];
}

interface InitOptions {
	help: boolean;
	headless: boolean;
}

function parseInitOptions(args: string[]): InitOptions {
	const options: InitOptions = { help: false, headless: false };
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg === "--headless") {
			options.headless = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown init option: ${arg}`);
		throw new Error(`unexpected init argument: ${arg}`);
	}
	return options;
}

/** Load effective settings from the split config shape at `bridgeDir`, defaulting missing fields. */
function loadSplitRcSettings(bridgeDir: string): RcSettings {
	const detectedPilot = loadGitPilotIdentity(bridgeDir);
	const basePath = baseConfigPath(bridgeDir);
	const base = existsSync(basePath)
		? parseYamlBlock(readFileSync(basePath, "utf8"), basePath)
		: emptyYaml();
	const localPath = localConfigPath(bridgeDir);
	const local = existsSync(localPath)
		? parseYamlBlock(readFileSync(localPath, "utf8"), localPath)
		: emptyYaml();

	return {
		workspace: base.scalars.workspace ?? DEFAULT_RC.workspace,
		backlog: base.scalars.backlog ?? DEFAULT_RC.backlog,
		kb: base.scalars.kb ?? DEFAULT_RC.kb,
		homeBranch: base.scalars["home-branch"] ?? DEFAULT_RC["home-branch"],
		workBranchPrefix: base.scalars["work-branch-prefix"] ?? DEFAULT_RC["work-branch-prefix"],
		pilotName: local.scalars["pilot-name"] ?? detectedPilot.pilotName,
		pilotEmail: local.scalars["pilot-email"] ?? detectedPilot.pilotEmail,
		agents:
			base.lists.agents && base.lists.agents.length > 0
				? base.lists.agents
				: [...DEFAULT_RC.agents],
	};
}

function renderBaseConfig(settings: RcSettings, schemaVersion: number): string {
	return [
		`schema-version: ${schemaVersion}`,
		`workspace: ${settings.workspace}`,
		`backlog: ${settings.backlog}`,
		`kb: ${settings.kb}`,
		`home-branch: ${settings.homeBranch}`,
		`work-branch-prefix: ${settings.workBranchPrefix}`,
		`agents:`,
		...settings.agents.map((agent) => `  - ${agent}`),
		"",
	].join("\n");
}

function renderLocalConfig(settings: RcSettings): string {
	return [`pilot-name: ${settings.pilotName}`, `pilot-email: ${settings.pilotEmail}`, ""].join(
		"\n",
	);
}

// --- migrations ----------------------------------------------------------

interface MigrationContext {
	bridgeDir: string;
}

interface Migration {
	fromVersion: number;
	toVersion: number;
	/** kind: migration kb doc id, read from the package (never seeded into a bridge's kb) for error output. */
	docId: string;
	/** Script artifact path, relative to the installed package root. */
	scriptRelPath: string;
	/** Short human-facing description, mirrors the doc's gist, for log/error output. */
	summary: string;
}

const MIGRATIONS: Migration[] = [
	{
		fromVersion: 0,
		toVersion: 1,
		docId: "00000000-0061-77ed-a060-f803c8f5aa76",
		scriptRelPath: join("kb", "artifacts", "00000000-0076-7dad-af72-3e32d35642f4.mjs"),
		summary:
			"Split single .nosediverc into checked-in .nosedive/config.yaml plus gitignored .nosedive.local.yaml",
	},
];

type ConfigShapeInfo =
	| { kind: "none" }
	| { kind: "legacy" }
	| { kind: "split"; version: number }
	| { kind: "split-unversioned" }
	| { kind: "ambiguous" };

/** Detect config shape in `bridgeDir` only -- init never considers ancestor directories. */
function detectConfigShapeAt(bridgeDir: string): ConfigShapeInfo {
	const hasBase = existsSync(baseConfigPath(bridgeDir));
	const hasLegacy = existsSync(legacyConfigPath(bridgeDir));

	if (hasBase && hasLegacy) return { kind: "ambiguous" };
	if (hasBase) {
		const basePath = baseConfigPath(bridgeDir);
		const base = parseYamlBlock(readFileSync(basePath, "utf8"), basePath);
		const raw = base.scalars["schema-version"];
		const version = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
		return Number.isInteger(version) ? { kind: "split", version } : { kind: "split-unversioned" };
	}
	if (hasLegacy) return { kind: "legacy" };
	return { kind: "none" };
}

/**
 * Full content of a migration's kb doc (gist + body), read directly from the
 * installed package -- never seeded into a bridge's kb, so this is the only
 * place a developer or agent sees it: inline in a failure, when it's
 * actually actionable.
 */
function describeMigrationForError(docId: string): string {
	const doc = packageMigrationDocs().find((d) => d.filename === `${docId}.md`);
	if (!doc) return `(kind: migration doc ${docId} not found in the installed nosedive package)`;
	const parsed = parseMarkdownDoc(doc.content, doc.filename);
	const gist = parsed.fm.scalars.gist;
	const body = parsed.body.trim();
	return [gist, "", body].filter((line): line is string => line !== undefined).join("\n");
}

function backupBeforeMigration(bridgeDir: string, migration: Migration, paths: string[]): void {
	const existing = paths.filter((p) => existsSync(p));
	if (existing.length === 0) return;

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = join(
		bridgeDir,
		SPLIT_CONFIG_DIRNAME,
		MIGRATION_BACKUP_DIRNAME,
		`v${migration.fromVersion}-to-v${migration.toVersion}-${stamp}`,
	);
	for (const path of existing) {
		writeFileAtomic(join(dir, basename(path)), readFileSync(path, "utf8"));
	}
}

async function runMigration(migration: Migration, ctx: MigrationContext): Promise<void> {
	const scriptPath = join(packageRoot(), migration.scriptRelPath);
	const mod = (await import(pathToFileURL(scriptPath).href)) as {
		migrate?: (ctx: MigrationContext) => void;
	};
	if (typeof mod.migrate !== "function")
		throw new Error(`migration script ${migration.scriptRelPath} does not export migrate()`);
	mod.migrate(ctx);
}

/**
 * Run every pending migration for `bridgeDir`, in order, failing loudly (with
 * no partial writes for the blocking step) on any unrecognized/ambiguous
 * shape or migration failure. Returns quickly with no I/O beyond the shape
 * check when the bridge is already current.
 */
async function migrateBridgeConfig(bridgeDir: string): Promise<void> {
	const shape = detectConfigShapeAt(bridgeDir);

	if (shape.kind === "ambiguous") {
		throw new Error(
			`bridge config is ambiguous: both ${formatPath(legacyConfigPath(bridgeDir))} and ` +
				`${formatPath(baseConfigPath(bridgeDir))} exist. Remove or reconcile one manually before running init again.`,
		);
	}
	if (shape.kind === "split-unversioned") {
		throw new Error(
			`${formatPath(baseConfigPath(bridgeDir))} exists but has no readable schema-version; ` +
				`refusing to guess its migration state. Fix or remove it manually before running init again.`,
		);
	}

	let version =
		shape.kind === "none" ? CURRENT_SCHEMA_VERSION : shape.kind === "legacy" ? 0 : shape.version;
	if (version === CURRENT_SCHEMA_VERSION) return; // already current: no-op, no further I/O

	const ctx: MigrationContext = { bridgeDir };
	while (version < CURRENT_SCHEMA_VERSION) {
		const migration = MIGRATIONS.find((m) => m.fromVersion === version);
		if (!migration) {
			const known = MIGRATIONS.map(
				(m) => `  v${m.fromVersion}->v${m.toVersion}: ${m.summary}`,
			).join("\n");
			throw new Error(
				`no migration path from schema version ${version} to ${CURRENT_SCHEMA_VERSION}; ` +
					`bridge config is in an unrecognized state.\nKnown migrations:\n${known}`,
			);
		}

		backupBeforeMigration(bridgeDir, migration, [
			legacyConfigPath(bridgeDir),
			baseConfigPath(bridgeDir),
		]);

		try {
			await runMigration(migration, ctx);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(
				`migration '${migration.summary}' (v${migration.fromVersion}->v${migration.toVersion}) failed: ${detail}\n\n` +
					describeMigrationForError(migration.docId),
			);
		}

		version = migration.toVersion;
	}
}

function loadGitPilotIdentity(bridgeDir: string): Pick<RcSettings, "pilotName" | "pilotEmail"> {
	return {
		pilotName: gitOutput(bridgeDir, ["config", "user.name"]) ?? "",
		pilotEmail: gitOutput(bridgeDir, ["config", "user.email"]) ?? "",
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
		process.stdout.write(
			`agents, comma-separated (options: ${KNOWN_AGENTS.join(", ")}) [${current.join(",")}]: `,
		);
		const line = await nextLine(iter);
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
			console.error(
				`unknown agent(s): ${unknown.join(", ")} (options: ${KNOWN_AGENTS.join(", ")})`,
			);
			continue;
		}
		if (list.length === 0) {
			console.error("select at least one agent");
			continue;
		}
		return list;
	}
}

function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function packageDocsOfKind(kind: string): Array<{ filename: string; content: string }> {
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

function packageFoundationDocs(): Array<{ filename: string; content: string }> {
	return packageDocsOfKind("foundation");
}

function packageMigrationDocs(): Array<{ filename: string; content: string }> {
	return packageDocsOfKind("migration");
}

function seedPackageDocs(
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

function seedPackageFoundationDocs(bridgeDir: string, kbPath: string): string[] {
	return seedPackageDocs(bridgeDir, kbPath, packageFoundationDocs());
}

const NOSEDIVE_DIR_GITIGNORE = ["cache/", `${MIGRATION_BACKUP_DIRNAME}/`, ""].join("\n");

/** nosedive owns ignore rules for its own state under `.nosedive/`: the git cache and migration backups are local, `config.yaml` is not. */
function writeNosediveDirGitignore(bridgeDir: string): void {
	writeFileAtomic(join(bridgeDir, SPLIT_CONFIG_DIRNAME, ".gitignore"), NOSEDIVE_DIR_GITIGNORE);
}

async function init(args: string[]): Promise<void> {
	const options = parseInitOptions(args);
	if (options.help) {
		console.log("Usage: nosedive init [--headless]");
		console.log(
			"  Create, migrate, or edit bridge config (.nosedive/config.yaml + .nosedive.local.yaml) in the current directory.",
		);
		console.log(
			"  Existing values (or built-in defaults) are shown as the default for each prompt; press Enter to keep it.",
		);
		console.log("  --headless skips prompts and writes existing values or configured defaults.");
		console.log(
			"  Every run first migrates an out-of-date bridge config to the latest schema (a no-op when already current).",
		);
		return;
	}

	const bridgeDir = process.cwd();
	if (!gitOutput(bridgeDir, ["rev-parse", "--show-toplevel"])) {
		throw new Error("nosedive init must be run inside a git repository");
	}

	await migrateBridgeConfig(bridgeDir);

	const settings = loadSplitRcSettings(bridgeDir);

	if (!options.headless) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const iter = rl[Symbol.asyncIterator]();
			settings.workspace = await promptScalar(iter, "workspace", settings.workspace);
			settings.backlog = await promptScalar(iter, "backlog", settings.backlog);
			settings.kb = await promptScalar(iter, "kb", settings.kb);
			settings.homeBranch = await promptScalar(iter, "home-branch", settings.homeBranch);
			settings.workBranchPrefix = await promptScalar(
				iter,
				"work-branch-prefix",
				settings.workBranchPrefix,
			);
			settings.pilotName = await promptScalar(iter, "pilot-name", settings.pilotName);
			settings.pilotEmail = await promptScalar(iter, "pilot-email", settings.pilotEmail);
			settings.agents = await promptAgents(iter, settings.agents);
		} finally {
			rl.close();
		}
	}

	const basePath = baseConfigPath(bridgeDir);
	const localPath = localConfigPath(bridgeDir);
	writeFileAtomic(basePath, renderBaseConfig(settings, CURRENT_SCHEMA_VERSION));
	writeFileAtomic(localPath, renderLocalConfig(settings));
	writeNosediveDirGitignore(bridgeDir);
	console.log(`Wrote ${formatPath(basePath)} and ${formatPath(localPath)}`);

	const seededFoundationDocs = seedPackageFoundationDocs(bridgeDir, settings.kb);
	for (const warning of manageFoundationGitState([localPath, ...seededFoundationDocs]))
		console.error(`warning: ${warning}`);
	if (seededFoundationDocs.length > 0) {
		console.log(
			`Seeded ${seededFoundationDocs.length} foundation doc${seededFoundationDocs.length === 1 ? "" : "s"} into ${settings.kb}`,
		);
	}
}

// --- whoami ------------------------------------------------------------

interface WhoamiOptions {
	help: boolean;
}

type IdentitySource = "rc" | "git" | "unset";

interface IdentityField {
	key: "pilot-name" | "pilot-email";
	value: string;
	source: IdentitySource;
}

function parseWhoamiOptions(args: string[]): WhoamiOptions {
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

function resolveIdentityField(
	key: IdentityField["key"],
	configured: string | undefined,
	detected: string,
): IdentityField {
	if (configured !== undefined) return { key, value: configured, source: "rc" };
	if (detected) return { key, value: detected, source: "git" };
	return { key, value: "<unset>", source: "unset" };
}

function whoami(args: string[]): void {
	const options = parseWhoamiOptions(args);
	if (options.help) {
		console.log("Usage: nosedive whoami");
		console.log("  Print the bridge pilot identity from .nosediverc, falling back to git config.");
		return;
	}

	const rc = readNosediveRc(process.cwd());
	const detected = loadGitPilotIdentity(rc.bridgeDir);
	const fields = [
		resolveIdentityField("pilot-name", rc.pilotName, detected.pilotName),
		resolveIdentityField("pilot-email", rc.pilotEmail, detected.pilotEmail),
	];

	for (const field of fields) console.log(`${field.key}: ${field.value}`);
	for (const field of fields) {
		if (field.source === "git") {
			console.error(
				`notice: ${field.key} inferred from git config; run \`nosedive init\` to persist it`,
			);
		}
		if (field.source === "unset") {
			console.error(
				`notice: ${field.key} is not configured in bridge config or git config; run \`nosedive init\` to persist it`,
			);
		}
	}

	if (fields.some((field) => field.source === "unset")) process.exitCode = 1;
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
	return nodes.flatMap((node) => [
		...(node.effort ? [node.effort] : []),
		...flattenEfforts(node.children),
	]);
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

function formatBacklogNode(
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

function formatBacklog(nodes: BacklogNode[], verbose: boolean): string {
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

function dumpBacklog(args: string[]): void {
	const verbose = args.includes("--verbose");
	const unknown = args.filter((arg) => arg !== "--verbose");
	if (unknown.length > 0) throw new Error(`unknown dump-backlog option: ${unknown[0]}`);

	const { backlogDir } = loadBacklogConfig(process.cwd());
	console.log(formatBacklog(collectBacklog(backlogDir), verbose));
}

interface ListDivesOptions {
	effortRef: string;
	includeHistorical: boolean;
	json: boolean;
}

interface ListedDive {
	id: string;
	name: string;
	gist: string;
	rel?: string;
	diver?: string;
	scopes: string[];
	source: string;
}

interface ListDivesResult {
	effort: string;
	pending: ListedDive[];
	working: ListedDive[];
	historical: ListedDive[];
	warnings: string[];
}

function parseListDivesArgs(args: string[]): ListDivesOptions {
	let effortRef: string | undefined;
	let includeHistorical = false;
	let json = false;

	for (const arg of args) {
		if (arg === "--include-historical") {
			includeHistorical = true;
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			console.log("Usage: nosedive list-dives <effort> [--include-historical] [--json]");
			console.log("  Print pending pickup dives and working dives for an open effort.");
			console.log("  --include-historical also prints preserved non-pending provenance dives.");
			return { effortRef: "", includeHistorical, json };
		}
		if (arg.startsWith("--")) throw new Error(`unknown list-dives option: ${arg}`);
		if (effortRef) throw new Error(`unexpected list-dives argument: ${arg}`);
		effortRef = arg;
	}

	if (!effortRef) throw new Error("list-dives requires an effort path or slug chain");
	return { effortRef, includeHistorical, json };
}

function diveDocs(kbDocs: KbDoc[]): KbDoc[] {
	return kbDocs.filter((doc) => doc.kind === "dive");
}

function formatScopeRef(scope: ScopeRef): string {
	const bits = [scope.repoId];
	if (scope.ref) bits.push(`@${scope.ref}`);
	if (scope.readOnly) bits.push(":ro");
	if (scope.path && scope.path !== ".") bits.push(` path=${scope.path}`);
	return bits.join("");
}

function listedDive(doc: KbDoc, rel?: string): ListedDive {
	return {
		id: doc.id,
		name: doc.name,
		gist: doc.gist,
		rel,
		diver: doc.metaScalars.diver || undefined,
		scopes: doc.scopes
			.filter((scope) => scope.repoId !== ".")
			.map((scope) => formatScopeRef(scope)),
		source: doc.relPath,
	};
}

function sameEffortRef(
	effortRef: string | undefined,
	effortPath: string,
	bridgeDir: string,
	backlogDir: string,
): boolean {
	if (!effortRef) return false;
	try {
		return resolveEffortPath(effortRef, bridgeDir, backlogDir, "dive effort") === effortPath;
	} catch {
		return false;
	}
}

const DIVE_WORKING_RELS = new Set(["working", "reviewing"]);

function collectListDives(
	effortPath: string,
	rc: NosediveRc,
	kbDocs: KbDoc[],
	includeHistorical: boolean,
): ListDivesResult {
	if (!rc.backlogDir) throw new Error(".nosediverc is missing backlog");
	const effortText = readFileSync(effortPath, "utf8");
	const links = parseLinkRefs(parseRawFrontmatterObject(effortText, effortPath).links, effortPath);
	const dives = diveDocs(kbDocs);
	const divesById = new Map(dives.map((doc) => [doc.id, doc]));
	const kbIds = new Set(kbDocs.map((doc) => doc.id));
	const effortLabel = effortRefFromPath(effortPath, rc.backlogDir);

	const pending: ListedDive[] = [];
	const working: ListedDive[] = [];
	const provenance: ListedDive[] = [];
	const warnings: string[] = [];
	const linkedDiveIds = new Set<string>();

	for (const link of links) {
		const dive = divesById.get(link.id);
		if (!dive) {
			// A rel-tagged link asserts a pickupable/working dive, so a missing
			// target is a broken dive ref worth surfacing. Bare provenance links
			// to non-dive docs are ignored here.
			if (link.rel && !kbIds.has(link.id)) {
				warnings.push(`dive link ${link.id} is missing from kb`);
			}
			continue;
		}
		if (!sameEffortRef(dive.effortRef, effortPath, rc.bridgeDir, rc.backlogDir)) {
			warnings.push(`dive link ${link.id} does not point back at ${effortLabel}`);
			continue;
		}
		linkedDiveIds.add(dive.id);
		if (link.rel === "pending") {
			pending.push(listedDive(dive, link.rel));
		} else if (DIVE_WORKING_RELS.has(link.rel ?? "") || dive.metaScalars.diver) {
			working.push(listedDive(dive, link.rel));
		} else {
			provenance.push(listedDive(dive, link.rel));
		}
	}

	// Drift/superset scan: dives that name this effort but are not linked from it.
	// A held (diver set) unlinked dive is a workon-safety hazard, so warn; the
	// full progression view (--include-historical) also lists them.
	for (const dive of dives) {
		if (linkedDiveIds.has(dive.id)) continue;
		if (!sameEffortRef(dive.effortRef, effortPath, rc.bridgeDir, rc.backlogDir)) continue;
		if (dive.metaScalars.diver) {
			warnings.push(
				`held dive ${dive.id} points at ${effortLabel} but is not linked from the effort`,
			);
		}
		provenance.push(listedDive(dive));
	}

	return {
		effort: effortLabel,
		pending,
		working,
		historical: includeHistorical ? provenance : [],
		warnings,
	};
}

function formatListedDive(dive: ListedDive): string {
	const rel = dive.rel ? ` rel=${dive.rel}` : "";
	const diver = dive.diver ? ` diver=${dive.diver}` : "";
	const scopes = dive.scopes.length > 0 ? ` scopes=${dive.scopes.join(",")}` : "";
	const gist = dive.gist ? ` - ${dive.gist}` : "";
	return `  - ${dive.id} ${dive.name}${rel}${diver}${scopes}${gist}`;
}

function appendDiveSection(lines: string[], label: string, dives: ListedDive[]): void {
	lines.push(`${label}:`);
	if (dives.length === 0) {
		lines.push("  (none)");
		return;
	}
	for (const dive of dives) lines.push(formatListedDive(dive));
}

function formatListDivesResult(result: ListDivesResult, includeHistorical: boolean): string {
	const lines = [`Effort: ${result.effort}`];
	appendDiveSection(lines, "Pending", result.pending);
	appendDiveSection(lines, "Working", result.working);
	if (includeHistorical) appendDiveSection(lines, "Historical", result.historical);
	if (result.warnings.length > 0) {
		lines.push("Warnings:");
		for (const warning of result.warnings) lines.push(`  - ${warning}`);
	}
	return lines.join("\n");
}

function listDives(args: string[]): void {
	const options = parseListDivesArgs(args);
	if (!options.effortRef) return;

	const rc = readNosediveRc(process.cwd());
	if (!rc.backlogDir) throw new Error(".nosediverc is missing backlog");
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");

	const effortPath = resolveEffortPath(options.effortRef, rc.bridgeDir, rc.backlogDir);
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const result = collectListDives(effortPath, rc, kbDocs, options.includeHistorical);

	if (options.json) console.log(JSON.stringify(result, null, 2));
	else console.log(formatListDivesResult(result, options.includeHistorical));
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
			if (!candidate.endsWith(".md"))
				throw new Error(`parent path is not an effort markdown file: ${parentRef}`);
			const dir = dirname(candidate);
			if (!isInsideDir(backlogDir, dir))
				throw new Error(`parent path is outside backlog: ${parentRef}`);
			return assertEffortDirInsideBacklog(dir, backlogDir, `parent path ${parentRef}`);
		}
		if (stats.isDirectory())
			return assertBacklogDir(candidate, backlogDir, `parent path ${parentRef}`);
	}

	const matches = collectEfforts(backlogDir).filter((effort) => effort.chain === parentRef);
	if (matches.length === 1) return dirname(matches[0]!.path);
	if (matches.length > 1) throw new Error(`parent effort is ambiguous: ${parentRef}`);
	throw new Error(`parent effort not found: ${parentRef}`);
}

function resolveEffortPath(
	effortRef: string,
	bridgeDir: string,
	backlogDir: string,
	label = "effort",
): string {
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
			if (!candidate.endsWith(".md"))
				throw new Error(`${label} path is not an effort markdown file: ${effortRef}`);
			if (!isInsideDir(backlogDir, candidate))
				throw new Error(`${label} path is outside backlog: ${effortRef}`);
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

function parsePitchArgs(args: string[]): {
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
	homeBranch?: string;
	workBranchPrefix?: string;
	pilotName?: string;
	pilotEmail?: string;
	agents: string[];
	effortPath?: string;
	effortRef?: string;
	activeDiveId?: string;
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
	effortRef?: string;
	metaScalars: Record<string, string>;
	metaLists: Record<string, string[]>;
	metaRaw: Record<string, unknown>;
	scopes: ScopeRef[];
	links: LinkRef[];
}

interface ScopeRef {
	repoId: string;
	path: string;
	ref?: string;
	readOnly: boolean;
	flags: string[];
	render?: "body" | "gist";
}

interface LinkRef {
	id: string;
	rel?: string;
	anchor?: string;
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
	agentFiles: string[];
	tags: Set<string>;
	targets: Map<string, TargetDoc[]>;
	warnings: string[];
}

function currentDeveloperId(bridgeDir: string): string | undefined {
	return (
		gitOutput(bridgeDir, ["config", "user.email"]) || gitOutput(bridgeDir, ["config", "user.name"])
	);
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
	return effortRefFromPath(
		resolveEffortPath(held[0]!, rc.bridgeDir, rc.backlogDir, "held dive effort"),
		rc.backlogDir,
	);
}

function loadBridgeConfig(start: string): BridgeConfig {
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

function parseEffortRepos(path: string): EffortRepo[] {
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

function loadKbDocs(kbDir: string, bridgeDir: string): KbDoc[] {
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
				repoBaseBranch: fm.nested.meta?.["base-branch"],
				effortRef: fm.scalars.effort ?? fm.nested.meta?.effort,
				metaScalars: fm.nested.meta ?? {},
				metaLists: fm.nestedLists.meta ?? {},
				metaRaw:
					raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta)
						? (raw.meta as Record<string, unknown>)
						: {},
				scopes: parseScopeRefs(raw.scopes, path),
				links: fm.scalars.kind === "assertion" ? parseLinkRefs(raw.links, path) : [],
			};
		});
}

function parseRawFrontmatterObject(text: string, label: string): Record<string, unknown> {
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

function readActiveDiveId(workspaceDir: string | undefined): string | undefined {
	if (!workspaceDir) return undefined;
	const markerPath = join(workspaceDir, ".nosedive-ref");
	if (!existsSync(markerPath)) return undefined;
	const marker = parseYamlBlock(readFileSync(markerPath, "utf8"), markerPath);
	return marker.scalars.id;
}

function isWorkspaceEmpty(workspaceDir: string | undefined): boolean {
	if (!workspaceDir || !existsSync(workspaceDir)) return true;
	if (!statSync(workspaceDir).isDirectory()) return false;
	return readdirSync(workspaceDir).filter((entry) => entry !== ".nosedive-ref").length === 0;
}

function isPathIgnoredByGitStatus(repoRoot: string, path: string): boolean {
	const rel = gitRelPath(repoRoot, path);
	if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
	const status = gitOutput(repoRoot, ["status", "--ignored", "--short", "--", rel]);
	return Boolean(status?.split(/\r?\n/).some((line) => line.startsWith("!! ")));
}

function computeApplyTags(bridge: BridgeConfig): Set<string> {
	const tags = new Set<string>();
	if (isWorkspaceEmpty(bridge.workspaceDir)) tags.add("workspace-is-empty");
	if (bridge.pilotName?.trim() || bridge.pilotEmail?.trim()) tags.add("pilot-is-set");
	if (bridge.backlogDir && !existsSync(bridge.backlogDir)) tags.add("backlog-is-missing");
	if (bridge.backlogDir && isPathIgnoredByGitStatus(bridge.bridgeDir, bridge.backlogDir))
		tags.add("backlog-is-ignored");
	return tags;
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
	const repo = maybeResolveRepoDoc(kbDocs, repoRef);
	if (repo) return repo;
	throw new Error(`repo not found: ${repoRef}`);
}

function maybeResolveRepoDoc(kbDocs: KbDoc[], repoRef: string): KbDoc | undefined {
	const byId = repoDocs(kbDocs).filter((doc) => doc.id === repoRef);
	if (byId.length === 1) return byId[0];

	const byName = repoDocs(kbDocs).filter((doc) => doc.name === repoRef);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(
			`repo name is ambiguous: ${repoRef} (${byName.map((doc) => doc.id).join(", ")})`,
		);
	}
	return undefined;
}

function formatEffortRepoEntry(repoId: string, ref: string | undefined, readOnly: boolean): string {
	return `${repoId}${ref ? `@${ref}` : ""}${readOnly ? ":ro" : ""}`;
}

function appendRepoToEffort(path: string, repo: EffortRepo): string {
	const existing = parseEffortRepos(path);
	if (existing.some((entry) => entry.id === repo.id))
		throw new Error(`effort already includes repo ${repo.id}: ${formatPath(path)}`);

	const text = readFileSync(path, "utf8");
	const frontmatter = splitMarkdownFrontmatter(text, path);
	const entry = formatEffortRepoEntry(repo.id, repo.ref, repo.readOnly);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0)
		throw new Error(
			`invalid YAML in frontmatter in ${path}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);

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
	return effortRef
		? resolveEffortPath(effortRef, rc.bridgeDir, rc.backlogDir, "active effort")
		: undefined;
}

function resolveAddRepoEffort(
	rc: NosediveRc,
	options: AddRepoOptions,
): { path: string; active: boolean } {
	if (!rc.backlogDir) throw new Error(".nosediverc is missing backlog");

	const activePath = activeEffortPath(rc);
	if (options.effortRef) {
		const explicitPath = resolveEffortPath(
			options.effortRef,
			rc.bridgeDir,
			rc.backlogDir,
			"effort",
		);
		return { path: explicitPath, active: activePath === explicitPath };
	}
	if (!activePath)
		throw new Error("add-repo requires --effort when no held dive or current effort is active");
	return { path: activePath, active: true };
}

function addRepo(args: string[]): void {
	const options = parseAddRepoArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const repoDoc = resolveRepoDoc(kbDocs, options.repoRef);
	const effort = resolveAddRepoEffort(rc, options);
	appendRepoToEffort(effort.path, {
		id: repoDoc.id,
		ref: options.repoEntryRef,
		readOnly: options.readOnly,
	});

	console.log(`Added ${repoDoc.id} to ${formatPath(effort.path)}`);

	if (options.apply && effort.active && rc.workspaceDir) {
		applyWrite();
	} else if (options.apply && !effort.active) {
		console.log("Generated docs not updated because the target effort is not active.");
	}
}

interface HydrateRepoWorkspaceOptions {
	repoRef: string;
	at: string;
	readOnly: boolean;
}

interface DehydrateRepoWorkspaceOptions {
	repoRef: string;
	force: boolean;
}

interface HydrateRepoWorkspaceResult {
	status: "created" | "updated" | "noop";
	repoId: string;
	targetPath: string;
	commit: string;
}

interface DehydrateRepoWorkspaceResult {
	status: "removed" | "noop";
	repoId: string;
	targetPath: string;
}

function parseHydrateRepoWorkspaceArgs(args: string[]): HydrateRepoWorkspaceOptions {
	let repoRef: string | undefined;
	let at = "main";
	let readOnly = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--at") {
			const value = args[i + 1];
			if (!value) throw new Error("--at requires a value");
			at = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--at=")) {
			at = arg.slice("--at=".length);
			if (!at) throw new Error("--at requires a value");
			continue;
		}
		if (arg === "--read-only") {
			readOnly = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown hydrate-repo.workspace option: ${arg}`);
		if (repoRef) throw new Error(`unexpected hydrate-repo.workspace argument: ${arg}`);
		repoRef = arg;
	}

	if (!repoRef) throw new Error("hydrate-repo.workspace requires a repo id or name");
	return { repoRef, at, readOnly };
}

function parseDehydrateRepoWorkspaceArgs(args: string[]): DehydrateRepoWorkspaceOptions {
	let repoRef: string | undefined;
	let force = false;

	for (const arg of args) {
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown dehydrate-repo.workspace option: ${arg}`);
		if (repoRef) throw new Error(`unexpected dehydrate-repo.workspace argument: ${arg}`);
		repoRef = arg;
	}

	if (!repoRef)
		throw new Error(
			"dehydrate-repo.workspace requires a repo id, name, or workspace-relative path",
		);
	return { repoRef, force };
}

interface GitCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

const GIT_SAFE_BARE_CONFIG_ARGS = ["-c", "safe.bareRepository=all"] as const;
const MANAGED_CACHE_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

function runGit(cwd: string, args: string[]): GitCommandResult {
	const result = spawnSync("git", [...GIT_SAFE_BARE_CONFIG_ARGS, ...args], {
		cwd: resolve(cwd),
		encoding: "utf8",
		env: cleanGitEnv(),
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function gitRun(cwd: string, args: string[], label: string): string {
	const result = runGit(cwd, args);
	if (result.status === 0) return result.stdout.trim();
	const detail = result.stderr.trim() || result.stdout.trim() || "unknown git error";
	throw new Error(`${label}: ${detail}`);
}

function uuidLike(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseRepoMarkerStrict(markerPath: string): { id: string } {
	const raw = readFileSync(markerPath, "utf8");
	const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines.some((line) => /^\s/.test(line))) {
		throw new Error(
			`invalid marker format at ${formatPath(markerPath)}: no leading indentation is allowed`,
		);
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`invalid marker YAML at ${formatPath(markerPath)}: ${detail}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`invalid marker format at ${formatPath(markerPath)}: expected a YAML object`);
	}

	const obj = parsed as Record<string, unknown>;
	const keys = Object.keys(obj);
	if (keys.length !== 1 || keys[0] !== "id") {
		throw new Error(
			`invalid marker format at ${formatPath(markerPath)}: expected exactly one top-level key 'id'`,
		);
	}

	const idValue = scalarToString(obj.id)?.trim();
	if (!idValue || !uuidLike(idValue)) {
		throw new Error(`invalid marker format at ${formatPath(markerPath)}: id must be UUID-shaped`);
	}

	return { id: idValue };
}

function realpathStable(path: string): string {
	if (existsSync(path)) return realpathSync(path);

	let current = resolve(path);
	const missingSegments: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		missingSegments.unshift(current.slice(parent.length).replace(/^[\\/]/, ""));
		current = parent;
	}

	const base = existsSync(current) ? realpathSync(current) : resolve(path);
	return missingSegments.reduce((acc, segment) => resolve(acc, segment), base);
}

function ensureSafeTargetPath(repoId: string, targetPath: string, workspaceDir: string): void {
	const canonicalWorkspace = realpathStable(workspaceDir);
	const canonicalTarget = realpathStable(targetPath);
	if (!isInsideDir(canonicalWorkspace, canonicalTarget)) {
		throw new Error(
			`unsafe target path for repo ${repoId}: ${formatPath(targetPath)} resolves outside workspace ${formatPath(workspaceDir)}`,
		);
	}
}

interface RepoRemotes {
	cloud?: string;
	local?: string;
}

function repoRemotes(repoDoc: KbDoc): RepoRemotes {
	const remotes = repoDoc.metaRaw.remotes;
	if (!remotes || typeof remotes !== "object" || Array.isArray(remotes)) {
		throw new Error(
			`repo ${repoDoc.id} is missing usable meta.remotes.cloud or meta.remotes.local in ${repoDoc.relPath}`,
		);
	}

	const raw = remotes as Record<string, unknown>;
	const cloud = scalarToString(raw.cloud)?.trim();
	const local = scalarToString(raw.local)?.trim();
	if (!cloud && !local) {
		throw new Error(
			`repo ${repoDoc.id} is missing usable meta.remotes.cloud or meta.remotes.local in ${repoDoc.relPath}`,
		);
	}

	return { cloud, local };
}

function remoteLooksLikeUrl(remote: string): boolean {
	return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote) || /^[^@\s]+@[^:\s]+:.+/.test(remote);
}

function resolveRemoteForGit(remote: string, bridgeDir: string): string {
	return remoteLooksLikeUrl(remote) ? remote : resolveFrom(bridgeDir, remote);
}

function ensureLocalSeedUsable(repoId: string, sourcePath: string): void {
	if (!existsSync(sourcePath)) {
		throw new Error(`repo ${repoId} local seed does not exist: ${formatPath(sourcePath)}`);
	}
	if (!statSync(sourcePath).isDirectory()) {
		throw new Error(`repo ${repoId} local seed is not a directory: ${formatPath(sourcePath)}`);
	}
	if (!gitOutput(sourcePath, ["rev-parse", "--git-dir"])) {
		throw new Error(`repo ${repoId} local seed is not a git repository: ${formatPath(sourcePath)}`);
	}
}

function managedCachePath(repoId: string, bridgeDir: string): string {
	return join(bridgeDir, ".nosedive", "cache", repoId);
}

function cacheRemoteValue(
	repoDoc: KbDoc,
	bridgeDir: string,
): { remote: string; sourceKind: "cloud" | "local" } {
	const remotes = repoRemotes(repoDoc);
	if (remotes.cloud)
		return { remote: resolveRemoteForGit(remotes.cloud, bridgeDir), sourceKind: "cloud" };
	if (!remotes.local) {
		throw new Error(
			`repo ${repoDoc.id} is missing usable meta.remotes.cloud or meta.remotes.local in ${repoDoc.relPath}`,
		);
	}

	const local = resolveRemoteForGit(remotes.local, bridgeDir);
	ensureLocalSeedUsable(repoDoc.id, local);
	return { remote: local, sourceKind: "local" };
}

function ensureOriginRemote(cachePath: string, remote: string, repoId: string): void {
	const remotes = gitOutput(cachePath, ["remote"])?.split(/\r?\n/).filter(Boolean) ?? [];
	if (!remotes.includes("origin")) {
		gitRun(
			cachePath,
			["remote", "add", "origin", remote],
			`failed to configure cache remote for repo ${repoId}`,
		);
	} else {
		const current = gitOutput(cachePath, ["remote", "get-url", "origin"]);
		if (current !== remote) {
			gitRun(
				cachePath,
				["remote", "set-url", "origin", remote],
				`failed to configure cache remote for repo ${repoId}`,
			);
		}
	}

	const fetchRefspecs =
		gitOutput(cachePath, ["config", "--get-all", "remote.origin.fetch"])
			?.split(/\r?\n/)
			.filter(Boolean) ?? [];
	if (fetchRefspecs.length !== 1 || fetchRefspecs[0] !== MANAGED_CACHE_FETCH_REFSPEC) {
		gitRun(
			cachePath,
			["config", "--replace-all", "remote.origin.fetch", MANAGED_CACHE_FETCH_REFSPEC],
			`failed to configure cache fetch refspec for repo ${repoId}`,
		);
	}
}

function ensureManagedRepoCache(repoDoc: KbDoc, bridgeDir: string): string {
	const cachePath = managedCachePath(repoDoc.id, bridgeDir);
	const { remote, sourceKind } = cacheRemoteValue(repoDoc, bridgeDir);

	if (!existsSync(cachePath)) {
		mkdirSync(dirname(cachePath), { recursive: true });
		gitRun(
			dirname(cachePath),
			["clone", "--bare", remote, cachePath],
			`failed to prepare managed cache for repo ${repoDoc.id} from meta.remotes.${sourceKind}=${remote}`,
		);
		ensureOriginRemote(cachePath, remote, repoDoc.id);
		return cachePath;
	}

	if (!statSync(cachePath).isDirectory()) {
		throw new Error(
			`repo ${repoDoc.id} managed cache is not a directory: ${formatPath(cachePath)}`,
		);
	}
	if (!gitOutput(cachePath, ["rev-parse", "--git-dir"])) {
		throw new Error(
			`repo ${repoDoc.id} managed cache is not a git repository: ${formatPath(cachePath)}`,
		);
	}

	ensureOriginRemote(cachePath, remote, repoDoc.id);
	return cachePath;
}

function expectedWorktreePath(repoDoc: KbDoc, bridgeDir: string): string {
	const worktreePath = repoDoc.repoPath ?? repoDoc.metaScalars["worktree-path"];
	if (!worktreePath) {
		throw new Error(
			`repo ${repoDoc.id} is missing meta.path and deprecated meta.worktree-path fallback in ${repoDoc.relPath}`,
		);
	}
	return resolveFrom(bridgeDir, worktreePath);
}

function worktreeHasExpectedSource(targetPath: string, sourcePath: string): boolean {
	const sourceCommonRaw = gitOutput(sourcePath, ["rev-parse", "--git-common-dir"]);
	const targetCommonRaw = gitOutput(targetPath, ["rev-parse", "--git-common-dir"]);
	if (!sourceCommonRaw || !targetCommonRaw) return false;

	const sourceCommonPath = realpathStable(resolveFrom(sourcePath, sourceCommonRaw));
	const targetCommonPath = realpathStable(resolveFrom(targetPath, targetCommonRaw));
	return sourceCommonPath === targetCommonPath;
}

function maybeFetchSource(sourcePath: string, repoId: string): void {
	const remotes = gitOutput(sourcePath, ["remote"]);
	if (!remotes) return;
	const fetched = runGit(sourcePath, ["fetch", "--all", "--prune"]);
	if (fetched.status !== 0) {
		const detail = fetched.stderr.trim() || fetched.stdout.trim() || "unknown git error";
		throw new Error(
			`failed to fetch managed cache for repo ${repoId} at ${formatPath(sourcePath)}: ${detail}`,
		);
	}
}

function pruneStaleWorktrees(sourcePath: string, repoId: string): void {
	gitRun(
		sourcePath,
		["worktree", "prune"],
		`failed to prune stale worktrees for repo ${repoId} at ${formatPath(sourcePath)}`,
	);
}

function resolveRefCommit(sourcePath: string, repoId: string, ref: string): string {
	maybeFetchSource(sourcePath, repoId);
	const remoteCommit = gitOutput(sourcePath, [
		"rev-parse",
		"--verify",
		`refs/remotes/origin/${ref}^{commit}`,
	]);
	if (remoteCommit) return remoteCommit;
	return gitRun(
		sourcePath,
		["rev-parse", "--verify", `${ref}^{commit}`],
		`failed to resolve ref for repo ${repoId}: ref=${ref}`,
	);
}

function markerPathForTarget(targetPath: string): string {
	return join(targetPath, ".nosedive-ref");
}

function isDirEmpty(path: string): boolean {
	return readdirSync(path).length === 0;
}

function ensureReusableExistingTarget(
	repoId: string,
	targetPath: string,
	sourcePath: string,
): void {
	const markerPath = markerPathForTarget(targetPath);
	if (!existsSync(markerPath)) {
		throw new Error(
			`unsafe target path for repo ${repoId}: non-empty target is missing ${formatPath(markerPath)}`,
		);
	}

	const marker = parseRepoMarkerStrict(markerPath);
	if (marker.id !== repoId) {
		throw new Error(
			`marker mismatch for repo ${repoId} at ${formatPath(targetPath)}: expected id=${repoId}, found id=${marker.id}`,
		);
	}

	if (!gitOutput(targetPath, ["rev-parse", "--is-inside-work-tree"])) {
		throw new Error(
			`unsafe target path for repo ${repoId}: ${formatPath(targetPath)} is not a git worktree`,
		);
	}
	if (!worktreeHasExpectedSource(targetPath, sourcePath)) {
		throw new Error(
			`unsafe target path for repo ${repoId}: ${formatPath(targetPath)} is a git worktree for a different source repository`,
		);
	}
}

function ensureDehydratePathInsideWorkspace(
	pathRef: string,
	bridgeDir: string,
	workspaceDir: string,
): string {
	if (isAbsolute(pathRef)) {
		throw new Error(
			`unsafe dehydrate target path: expected a workspace-relative path, got absolute path ${formatPath(pathRef)}`,
		);
	}

	const candidate = resolve(bridgeDir, pathRef);
	if (!isInsideDir(workspaceDir, candidate)) {
		throw new Error(
			`unsafe dehydrate target path: ${pathRef} resolves outside configured workspace ${formatPath(workspaceDir)}`,
		);
	}
	return candidate;
}

function resolveDehydrateTargetFromPath(
	pathRef: string,
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string,
): { repoDoc: KbDoc; targetPath: string } {
	const resolved = ensureDehydratePathInsideWorkspace(pathRef, bridgeDir, workspaceDir);
	const markerPath = resolved.endsWith(".nosedive-ref")
		? resolved
		: join(resolved, ".nosedive-ref");
	if (!existsSync(markerPath)) {
		throw new Error(
			`unsafe dehydrate target path: expected managed marker at ${formatPath(markerPath)}`,
		);
	}
	if (!statSync(markerPath).isFile()) {
		throw new Error(
			`unsafe dehydrate target path: marker is not a file at ${formatPath(markerPath)}`,
		);
	}

	const marker = parseRepoMarkerStrict(markerPath);
	const repoDoc = repoDocs(kbDocs).find((doc) => doc.id === marker.id);
	if (!repoDoc) {
		throw new Error(`repo not found for marker id ${marker.id}: ${formatPath(markerPath)}`);
	}

	const targetPath = expectedWorktreePath(repoDoc, bridgeDir);
	ensureSafeTargetPath(repoDoc.id, targetPath, workspaceDir);

	const inputTargetPath = resolved.endsWith(".nosedive-ref") ? dirname(resolved) : resolved;
	if (realpathStable(inputTargetPath) !== realpathStable(targetPath)) {
		throw new Error(
			`unsafe dehydrate target path: ${formatPath(inputTargetPath)} does not match configured workspace target ${formatPath(targetPath)} for repo ${repoDoc.id}`,
		);
	}

	return { repoDoc, targetPath };
}

function ensureDehydrateTargetOwnership(repoId: string, targetPath: string): void {
	if (!statSync(targetPath).isDirectory()) {
		throw new Error(
			`unsafe target path for repo ${repoId}: target exists but is not a directory: ${formatPath(targetPath)}`,
		);
	}

	const markerPath = markerPathForTarget(targetPath);
	if (!existsSync(markerPath)) {
		throw new Error(
			`unsafe target path for repo ${repoId}: target is missing managed marker ${formatPath(markerPath)}`,
		);
	}

	const marker = parseRepoMarkerStrict(markerPath);
	if (marker.id !== repoId) {
		throw new Error(
			`marker mismatch for repo ${repoId} at ${formatPath(targetPath)}: expected id=${repoId}, found id=${marker.id}`,
		);
	}

	if (!gitOutput(targetPath, ["rev-parse", "--is-inside-work-tree"])) {
		throw new Error(
			`unsafe target path for repo ${repoId}: ${formatPath(targetPath)} is not a git worktree`,
		);
	}
}

function dehydrateHasUncommittedWork(targetPath: string): boolean {
	const status = gitOutput(targetPath, ["status", "--short"]);
	return Boolean(status && status.trim());
}

function dehydrateHasUnpublishedCommits(targetPath: string): boolean {
	const refsContainingHeadRaw =
		gitOutput(targetPath, [
			"for-each-ref",
			"--format=%(refname)",
			"--contains",
			"HEAD",
			"refs/heads",
			"refs/remotes",
		]) ?? "";
	const refsContainingHead = refsContainingHeadRaw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const currentBranch = gitOutput(targetPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

	if (!currentBranch) return refsContainingHead.length === 0;

	const upstream = gitOutput(targetPath, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	if (upstream) {
		const aheadCount = gitRun(
			targetPath,
			["rev-list", "--count", `${upstream}..HEAD`],
			"failed to inspect unpublished commits",
		);
		return Number(aheadCount) > 0;
	}

	const currentHeadRef = `refs/heads/${currentBranch}`;
	const otherRefsContainHead = refsContainingHead.some((ref) => ref !== currentHeadRef);
	return !otherRefsContainHead;
}

function removeHydratedWorktree(repoId: string, targetPath: string, force: boolean): void {
	const commonDirRaw = gitOutput(targetPath, ["rev-parse", "--git-common-dir"]);
	if (!commonDirRaw) {
		throw new Error(
			`failed to resolve worktree source for repo ${repoId} at ${formatPath(targetPath)}`,
		);
	}
	const sourcePath = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(targetPath, commonDirRaw);

	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(targetPath);
	gitRun(
		sourcePath,
		args,
		`failed to remove hydrated worktree for repo ${repoId} at ${formatPath(targetPath)}`,
	);
}

function ensureDetachedAtCommit(targetPath: string, commit: string, repoId: string): boolean {
	const currentCommit = gitRun(
		targetPath,
		["rev-parse", "HEAD"],
		`failed to inspect current commit for repo ${repoId}`,
	);
	const symbolicHead = gitOutput(targetPath, ["symbolic-ref", "-q", "HEAD"]);
	if (currentCommit === commit && !symbolicHead) return false;

	gitRun(
		targetPath,
		["checkout", "--detach", commit],
		`failed to detach worktree for repo ${repoId} at ${formatPath(targetPath)}`,
	);
	return true;
}

function writeRepoMarker(targetPath: string, repoId: string): boolean {
	const markerPath = markerPathForTarget(targetPath);
	const expected = `id: ${repoId}\n`;
	const existing = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined;
	if (existing === expected) return false;
	writeFileAtomic(markerPath, expected);
	return true;
}

function ensureRepoMarkerExcluded(targetPath: string, repoId: string): boolean {
	const rawExcludePath = gitOutput(targetPath, ["rev-parse", "--git-path", "info/exclude"]);
	if (!rawExcludePath) {
		throw new Error(
			`failed to resolve git exclude path for repo ${repoId} at ${formatPath(targetPath)}`,
		);
	}

	const excludePath = isAbsolute(rawExcludePath)
		? rawExcludePath
		: resolve(targetPath, rawExcludePath);
	const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	const updated = replaceManagedExcludeBlock(existing, [".nosedive-ref"], REPO_MARKER_EXCLUDE_SPEC);
	if (updated === existing) return false;

	writeFileAtomic(excludePath, updated);
	return true;
}

function worktreeConfigEnabled(targetPath: string): boolean {
	return gitOutput(targetPath, ["config", "--get", "extensions.worktreeConfig"]) === "true";
}

interface GitWorktreeEntry {
	path: string;
	bare: boolean;
}

function gitWorktreeEntries(sourcePath: string, repoId: string): GitWorktreeEntry[] {
	const text = gitRun(
		sourcePath,
		["worktree", "list", "--porcelain"],
		`failed to list worktrees for repo ${repoId} at ${formatPath(sourcePath)}`,
	);
	const entries: GitWorktreeEntry[] = [];
	let current: GitWorktreeEntry | undefined;

	for (const line of text.split(/\r?\n/)) {
		if (!line) {
			if (current) entries.push(current);
			current = undefined;
			continue;
		}
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = { path: line.slice("worktree ".length), bare: false };
			continue;
		}
		if (line === "bare" && current) current.bare = true;
	}
	if (current) entries.push(current);
	return entries;
}

function ensureLinkedWorktreesNonBare(sourcePath: string, repoId: string): boolean {
	let changed = false;
	for (const entry of gitWorktreeEntries(sourcePath, repoId)) {
		if (entry.bare || !existsSync(entry.path)) continue;
		const current = gitOutput(entry.path, ["config", "--worktree", "--get", "core.bare"]);
		if (current === "false") continue;
		gitRun(
			entry.path,
			["config", "--worktree", "core.bare", "false"],
			`failed to mark linked worktree non-bare for repo ${repoId} at ${formatPath(entry.path)}`,
		);
		changed = true;
	}
	return changed;
}

function reconcilePushReadOnly(
	sourcePath: string,
	targetPath: string,
	readOnly: boolean,
	repoId: string,
): boolean {
	let changed = false;
	if (!worktreeConfigEnabled(sourcePath)) {
		if (!readOnly) return false;
		gitRun(
			sourcePath,
			["config", "extensions.worktreeConfig", "true"],
			`failed to enable worktree-local config for repo ${repoId}`,
		);
		changed = true;
	}
	if (ensureLinkedWorktreesNonBare(sourcePath, repoId)) changed = true;

	const pushUrl = gitOutput(targetPath, ["config", "--worktree", "--get", "remote.origin.pushurl"]);

	if (readOnly) {
		if (pushUrl === "no_push://disabled") return changed;
		gitRun(
			targetPath,
			["config", "--worktree", "--replace-all", "remote.origin.pushurl", "no_push://disabled"],
			`failed to enforce read-only push hardening for repo ${repoId}`,
		);
		return true;
	}

	if (!pushUrl) return changed;

	gitRun(
		targetPath,
		["config", "--worktree", "--unset-all", "remote.origin.pushurl"],
		`failed to clear worktree-local push URL override for repo ${repoId}`,
	);
	return true;
}

function hydrateRepoWorkspace(args: string[]): void {
	const options = parseHydrateRepoWorkspaceArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const repoDoc = resolveRepoDoc(kbDocs, options.repoRef);
	const repoId = repoDoc.id;

	const sourcePath = ensureManagedRepoCache(repoDoc, rc.bridgeDir);
	const targetPath = expectedWorktreePath(repoDoc, rc.bridgeDir);
	ensureSafeTargetPath(repoId, targetPath, rc.workspaceDir);
	const commit = resolveRefCommit(sourcePath, repoId, options.at);

	let status: HydrateRepoWorkspaceResult["status"] = "noop";
	let changed = false;
	const targetExists = existsSync(targetPath);

	if (targetExists && !statSync(targetPath).isDirectory()) {
		throw new Error(
			`unsafe target path for repo ${repoId}: target exists but is not a directory: ${formatPath(targetPath)}`,
		);
	}

	if (!targetExists || (statSync(targetPath).isDirectory() && isDirEmpty(targetPath))) {
		mkdirSync(dirname(targetPath), { recursive: true });
		pruneStaleWorktrees(sourcePath, repoId);
		gitRun(
			sourcePath,
			["worktree", "add", "--detach", targetPath, commit],
			`failed to create worktree for repo ${repoId} at ${formatPath(targetPath)}`,
		);
		if (writeRepoMarker(targetPath, repoId)) changed = true;
		if (ensureRepoMarkerExcluded(targetPath, repoId)) changed = true;
		status = "created";
	} else {
		ensureReusableExistingTarget(repoId, targetPath, sourcePath);
		if (ensureDetachedAtCommit(targetPath, commit, repoId)) changed = true;
		if (writeRepoMarker(targetPath, repoId)) changed = true;
		if (ensureRepoMarkerExcluded(targetPath, repoId)) changed = true;
	}

	if (reconcilePushReadOnly(sourcePath, targetPath, options.readOnly, repoId)) changed = true;
	if (status !== "created") status = changed ? "updated" : "noop";

	const result: HydrateRepoWorkspaceResult = {
		status,
		repoId,
		targetPath,
		commit,
	};
	console.log(
		`${result.status} repo=${result.repoId} path=${formatPath(result.targetPath)} commit=${result.commit}`,
	);
}

function dehydrateRepoWorkspace(args: string[]): void {
	const options = parseDehydrateRepoWorkspaceArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	let repoDoc = maybeResolveRepoDoc(kbDocs, options.repoRef);
	let targetPath: string;

	if (repoDoc) {
		targetPath = expectedWorktreePath(repoDoc, rc.bridgeDir);
		ensureSafeTargetPath(repoDoc.id, targetPath, rc.workspaceDir);
	} else {
		const resolved = resolveDehydrateTargetFromPath(
			options.repoRef,
			kbDocs,
			rc.bridgeDir,
			rc.workspaceDir,
		);
		repoDoc = resolved.repoDoc;
		targetPath = resolved.targetPath;
	}

	const repoId = repoDoc.id;
	if (!existsSync(targetPath)) {
		const noopResult: DehydrateRepoWorkspaceResult = { status: "noop", repoId, targetPath };
		console.log(
			`${noopResult.status} repo=${noopResult.repoId} path=${formatPath(noopResult.targetPath)}`,
		);
		return;
	}

	ensureDehydrateTargetOwnership(repoId, targetPath);
	if (!options.force && dehydrateHasUncommittedWork(targetPath)) {
		throw new Error(
			`refusing to dehydrate repo ${repoId} at ${formatPath(targetPath)}: checkout has uncommitted work; rerun with --force`,
		);
	}
	if (!options.force && dehydrateHasUnpublishedCommits(targetPath)) {
		throw new Error(
			`refusing to dehydrate repo ${repoId} at ${formatPath(targetPath)}: checkout has unpublished commits; rerun with --force`,
		);
	}

	removeHydratedWorktree(repoId, targetPath, options.force);
	const result: DehydrateRepoWorkspaceResult = { status: "removed", repoId, targetPath };
	console.log(`${result.status} repo=${result.repoId} path=${formatPath(result.targetPath)}`);
}

interface ProveOptions {
	assertionId: string;
	record: boolean;
	verbose: boolean;
}

interface ProverHostRequest {
	bridgeDir: string;
	kbDir: string;
	workspaceDir?: string;
	assertionId: string;
	assertionName: string;
	assertionPath: string;
	proverPath: string;
	resultPath: string;
	verbose: boolean;
}

interface ProverHostRepoInput {
	commit: string;
	dirty: boolean;
	path: string;
}

interface ProverHostResult {
	status: number;
	error?: string;
	inputs: Record<string, ProverHostRepoInput>;
}

interface RepoContext {
	id: string;
	root: string;
	resolve(path: string): string;
}

function parseProveArgs(args: string[]): ProveOptions {
	let assertionId: string | undefined;
	let record = false;
	let verbose = false;

	for (const arg of args) {
		if (arg === "--record") {
			record = true;
			continue;
		}
		if (arg === "--verbose") {
			verbose = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			throw new Error("Usage: nosedive prove <assertion-uuid> [--record] [--verbose]");
		}
		if (arg.startsWith("--")) throw new Error(`unknown prove option: ${arg}`);
		if (assertionId) throw new Error(`unexpected prove argument: ${arg}`);
		assertionId = arg;
	}

	if (!assertionId) throw new Error("prove requires an assertion uuid");
	if (!uuidLike(assertionId))
		throw new Error(`prove requires a UUID-shaped assertion id: ${assertionId}`);
	return { assertionId, record, verbose };
}

function findAssertionDoc(kbDocs: KbDoc[], assertionId: string): KbDoc {
	const matches = kbDocs.filter((doc) => doc.kind === "assertion" && doc.id === assertionId);
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`assertion id is ambiguous: ${assertionId}`);
	throw new Error(`assertion not found: ${assertionId}`);
}

function assertionProverLink(assertion: KbDoc): LinkRef {
	const links = assertion.links.filter((link) => link.rel === "prover");
	if (links.length === 1) return links[0]!;
	if (links.length === 0) throw new Error(`assertion ${assertion.id} is missing a rel=prover link`);
	throw new Error(`assertion ${assertion.id} has more than one rel=prover link`);
}

function resolveBridgeFileLink(bridgeDir: string, link: LinkRef, label: string): string {
	if (!link.id.startsWith("file://")) {
		throw new Error(`${label} must use file:// for now: ${link.id}`);
	}
	const relPath = link.id.slice("file://".length);
	if (!relPath || isAbsolute(relPath)) {
		throw new Error(`${label} must be a bridge-relative file:// link: ${link.id}`);
	}
	const path = resolveFrom(bridgeDir, relPath);
	if (!isInsideDir(bridgeDir, path)) {
		throw new Error(`${label} resolves outside the bridge: ${link.id}`);
	}
	return path;
}

function resolveProverArtifact(bridgeDir: string, assertion: KbDoc): string {
	const link = assertionProverLink(assertion);
	const path = resolveBridgeFileLink(bridgeDir, link, `assertion ${assertion.id} prover link`);
	if (!existsSync(path)) throw new Error(`prover artifact not found: ${formatPath(path)}`);
	if (!statSync(path).isFile())
		throw new Error(`prover artifact is not a file: ${formatPath(path)}`);
	return path;
}

function proofRunTempDir(): string {
	return mkdtempSync(join(tmpdir(), "nosedive-proof-"));
}

function readProverHostResult(path: string): ProverHostResult {
	if (!existsSync(path)) {
		throw new Error(`proof host did not write a result file: ${formatPath(path)}`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as ProverHostResult;
}

function bridgeStatusEntries(bridgeRoot: string): string[] {
	const result = runGit(bridgeRoot, ["status", "--porcelain", "-z"]);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || "unknown git error";
		throw new Error(`refusing to record proof because bridge status failed: ${detail}`);
	}
	return result.stdout.split("\0").filter(Boolean);
}

function isAllowedRecordUntrackedPath(
	bridgeRoot: string,
	workspaceDir: string | undefined,
	entry: string,
): boolean {
	if (!entry.startsWith("?? ")) return false;
	if (!workspaceDir) return false;
	const path = resolveFrom(bridgeRoot, entry.slice(3));
	return isInsideDir(workspaceDir, path);
}

function assertBridgeRecordable(
	bridgeDir: string,
	workspaceDir: string | undefined,
	proverPath: string,
): void {
	const bridgeRoot = gitOutput(bridgeDir, ["rev-parse", "--show-toplevel"]);
	if (!bridgeRoot) throw new Error("refusing to record proof because bridge is not a git repo");
	const proverRelPath = gitRelPath(bridgeRoot, proverPath);
	if (!gitOk(bridgeRoot, ["ls-files", "--error-unmatch", "--", proverRelPath])) {
		throw new Error(
			`refusing to record proof because prover is not checked in: ${formatPath(proverPath)}`,
		);
	}
	const blocking = bridgeStatusEntries(bridgeRoot).filter(
		(entry) => !isAllowedRecordUntrackedPath(bridgeRoot, workspaceDir, entry),
	);
	if (blocking.length > 0) {
		throw new Error(
			`refusing to record proof because bridge has tracked/staged changes or untracked files outside workspace: ${blocking.join(", ")}`,
		);
	}
}

function recordProofResult(assertionPath: string, result: ProverHostResult): void {
	const text = readFileSync(assertionPath, "utf8");
	const block = splitMarkdownFrontmatter(text, assertionPath);
	const doc = parseDocument(block.yaml);
	if (doc.errors.length > 0) {
		throw new Error(
			`invalid YAML in frontmatter in ${assertionPath}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);
	}

	const inputs: Record<string, { commit: string }> = {};
	for (const [repoId, input] of Object.entries(result.inputs)) {
		inputs[repoId] = { commit: input.commit };
	}

	doc.setIn(["meta", "last-proven"], {
		"exit-status": result.status,
		inputs,
	});
	doc.deleteIn(["meta", "last-proven-commit"]);

	writeFileAtomic(
		assertionPath,
		`---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n${block.body}`,
	);
}

async function prove(args: string[]): Promise<void> {
	const options = parseProveArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const assertion = findAssertionDoc(kbDocs, options.assertionId);
	const proverPath = resolveProverArtifact(rc.bridgeDir, assertion);
	const runDir = proofRunTempDir();
	const requestPath = join(runDir, "request.json");
	const resultPath = join(runDir, "result.json");
	const cliPath = join(packageRoot(), "dist", "cli.js");

	const request: ProverHostRequest = {
		bridgeDir: rc.bridgeDir,
		kbDir: rc.kbDir,
		workspaceDir: rc.workspaceDir,
		assertionId: assertion.id,
		assertionName: assertion.name,
		assertionPath: assertion.path,
		proverPath,
		resultPath,
		verbose: options.verbose,
	};
	writeFileAtomic(requestPath, `${JSON.stringify(request, null, 2)}\n`);

	const child = spawnSync(process.execPath, [cliPath, "__prove-host", requestPath], {
		cwd: rc.bridgeDir,
		encoding: "utf8",
		env: cleanGitEnv(),
	});
	if (child.stdout) process.stdout.write(child.stdout);
	if (child.stderr) process.stderr.write(child.stderr);

	const result = readProverHostResult(resultPath);
	if (result.status !== 0 || child.status !== 0) {
		throw new Error(result.error ?? `proof failed with exit status ${result.status}`);
	}

	if (options.record) {
		const dirty = Object.entries(result.inputs).filter(([, input]) => input.dirty);
		if (dirty.length > 0) {
			throw new Error(
				`refusing to record proof because accessed repo(s) are dirty: ${dirty
					.map(([repoId]) => repoId)
					.join(", ")}`,
			);
		}
		assertBridgeRecordable(rc.bridgeDir, rc.workspaceDir, proverPath);
		recordProofResult(assertion.path, result);
		console.log(`Proof recorded: ${assertion.id}`);
	} else {
		console.log(`Proof passed: ${assertion.id}`);
	}
	if (options.verbose && assertion.gist) console.log(`Gist: ${assertion.gist}`);
}

function scopeForRepo(assertion: KbDoc, repoId: string): ScopeRef | undefined {
	const scopes = assertion.scopes.filter((scope) => scope.repoId === repoId);
	if (scopes.length === 0) return undefined;
	const refs = [...new Set(scopes.map((scope) => scope.ref).filter(Boolean))];
	if (refs.length > 1) {
		throw new Error(`assertion ${assertion.id} has conflicting refs for scoped repo ${repoId}`);
	}
	return scopes[0];
}

function requiredScopeForRepo(assertion: KbDoc, repoDoc: KbDoc): ScopeRef {
	const scope = scopeForRepo(assertion, repoDoc.id);
	if (!scope) {
		throw new Error(
			`prover requested repo ${repoDoc.name || repoDoc.id} (${repoDoc.id}), but assertion ${assertion.id} does not scope it`,
		);
	}
	return scope;
}

function ensureProverRepoHydrated(
	repoDoc: KbDoc,
	assertion: KbDoc,
	request: ProverHostRequest,
): string {
	if (!request.workspaceDir) throw new Error(".nosediverc is missing workspace");
	const repoId = repoDoc.id;
	const scope = requiredScopeForRepo(assertion, repoDoc);
	const targetPath = expectedWorktreePath(repoDoc, request.bridgeDir);
	ensureSafeTargetPath(repoId, targetPath, request.workspaceDir);

	if (existsSync(targetPath)) {
		if (!statSync(targetPath).isDirectory()) {
			throw new Error(
				`unsafe target path for repo ${repoId}: target exists but is not a directory: ${formatPath(targetPath)}`,
			);
		}
		if (gitOutput(targetPath, ["rev-parse", "--is-inside-work-tree"])) return targetPath;
		if (!isDirEmpty(targetPath)) {
			throw new Error(
				`unsafe target path for repo ${repoId}: non-empty target is not a git worktree: ${formatPath(targetPath)}`,
			);
		}
	}

	const sourcePath = ensureManagedRepoCache(repoDoc, request.bridgeDir);
	const ref = scope.ref ?? repoDoc.repoBaseBranch ?? "main";
	const commit = resolveRefCommit(sourcePath, repoId, ref);
	mkdirSync(dirname(targetPath), { recursive: true });
	pruneStaleWorktrees(sourcePath, repoId);
	gitRun(
		sourcePath,
		["worktree", "add", "--detach", targetPath, commit],
		`failed to create worktree for repo ${repoId} at ${formatPath(targetPath)}`,
	);
	writeRepoMarker(targetPath, repoId);
	ensureRepoMarkerExcluded(targetPath, repoId);
	reconcilePushReadOnly(sourcePath, targetPath, scope.readOnly, repoId);
	return targetPath;
}

function materializeProverRepoContext(
	repoDoc: KbDoc,
	assertion: KbDoc,
	request: ProverHostRequest,
	accessedRepos: Map<string, string>,
): RepoContext {
	const root = ensureProverRepoHydrated(repoDoc, assertion, request);
	accessedRepos.set(repoDoc.id, root);
	return {
		id: repoDoc.id,
		root,
		resolve(path: string): string {
			return resolveFrom(root, path);
		},
	};
}

function proofRepoInputs(accessedRepos: Map<string, string>): Record<string, ProverHostRepoInput> {
	const inputs: Record<string, ProverHostRepoInput> = {};
	for (const [repoId, root] of accessedRepos) {
		const commit = gitRun(root, ["rev-parse", "HEAD"], `failed to read proof input ${repoId}`);
		const status = gitOutput(root, ["status", "--porcelain"]);
		inputs[repoId] = {
			commit,
			dirty: status === undefined ? true : status.trim() !== "",
			path: root,
		};
	}
	return inputs;
}

function shellishArg(arg: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}

function formatExecCommand(command: string, args: string[], cwd: string): string {
	const rendered = [command, ...args].map(shellishArg).join(" ");
	return `exec cwd=${formatPath(cwd)} ${rendered}`;
}

function createProverContext(request: ProverHostRequest) {
	const kbDocs = loadKbDocs(request.kbDir, request.bridgeDir);
	const assertion = findAssertionDoc(kbDocs, request.assertionId);
	const accessedRepos = new Map<string, string>();
	const sandboxes: string[] = [];

	const ctx = {
		assertion: {
			id: assertion.id,
			name: assertion.name,
			path: assertion.path,
			meta: assertion.metaRaw,
			scopes: assertion.scopes,
		},
		bridge: {
			root: request.bridgeDir,
			resolve(path: string): string {
				return resolveFrom(request.bridgeDir, path);
			},
		},
		repos: {
			async get(repoRef: string): Promise<RepoContext | undefined> {
				const repoDoc = maybeResolveRepoDoc(kbDocs, repoRef);
				if (!repoDoc) return undefined;
				return materializeProverRepoContext(repoDoc, assertion, request, accessedRepos);
			},
			async require(repoRef: string): Promise<RepoContext> {
				const repoDoc = resolveRepoDoc(kbDocs, repoRef);
				return materializeProverRepoContext(repoDoc, assertion, request, accessedRepos);
			},
		},
		sandbox: {
			async create(name = "run"): Promise<{ root: string; resolve(path: string): string }> {
				const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "-") || "run";
				const root = mkdtempSync(join(tmpdir(), `nosedive-proof-${safeName}-`));
				sandboxes.push(root);
				return {
					root,
					resolve(path: string): string {
						return resolveFrom(root, path);
					},
				};
			},
		},
		async exec(
			command: string,
			args: string[] = [],
			options?: { cwd?: string; env?: Record<string, string>; expectExitCode?: number },
		): Promise<{ status: number; stdout: string; stderr: string }> {
			if (!options?.cwd) throw new Error("ctx.exec requires options.cwd");
			if (request.verbose) console.log(formatExecCommand(command, args, options.cwd));
			const env = { ...cleanGitEnv(), ...(options.env ?? {}) };
			const spawnCommand = commandForSpawn(command, args);
			const result = spawnSync(spawnCommand.command, spawnCommand.args, {
				cwd: resolve(options.cwd),
				encoding: "utf8",
				env,
			});
			const status = result.status ?? 1;
			const expected = options.expectExitCode ?? 0;
			const stdout = spawnOutputText(result.stdout);
			const stderr = spawnOutputText(result.stderr);
			const execResult = {
				status,
				stdout,
				stderr,
			};
			if (status !== expected) {
				const detail =
					stderr.trim() ||
					stdout.trim() ||
					(result.error instanceof Error ? result.error.message : undefined) ||
					`exit status ${status}`;
				throw new Error(
					`command failed in ${formatPath(options.cwd)}: ${command} ${args.join(" ")}: ${detail}`,
				);
			}
			return execResult;
		},
		fs: {
			async readText(path: string): Promise<string> {
				return readFileSync(path, "utf8");
			},
			async writeText(path: string, contents: string): Promise<void> {
				mkdirSync(dirname(path), { recursive: true });
				writeFileAtomic(path, contents);
			},
			async exists(path: string): Promise<boolean> {
				return existsSync(path);
			},
		},
		git: {
			async init(path: string): Promise<void> {
				await ctx.exec("git", ["init", "-b", "main"], { cwd: path });
			},
		},
		path: nodePath,
		assert: {
			equal(actual: unknown, expected: unknown, message?: string): void {
				if (actual !== expected) throw new Error(message ?? `expected ${expected}, got ${actual}`);
			},
			ok(value: unknown, message?: string): void {
				if (!value) throw new Error(message ?? "expected value to be truthy");
			},
			match(value: string, pattern: RegExp, message?: string): void {
				if (!pattern.test(value))
					throw new Error(message ?? `expected ${value} to match ${pattern}`);
			},
		},
		log(message: string): void {
			console.log(message);
		},
	};

	return {
		ctx,
		inputs(): Record<string, ProverHostRepoInput> {
			return proofRepoInputs(accessedRepos);
		},
		cleanup(success: boolean): void {
			if (!success) return;
			for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
		},
	};
}

async function proveHost(args: string[]): Promise<void> {
	const [requestPath, ...extra] = args;
	if (!requestPath || extra.length > 0) throw new Error("__prove-host requires one request path");

	const request = JSON.parse(readFileSync(requestPath, "utf8")) as ProverHostRequest;
	const session = createProverContext(request);
	let status = 0;
	let error: string | undefined;

	try {
		console.log(
			request.verbose
				? `Proving: ${request.assertionName} (${request.assertionId})`
				: `Proving: ${request.assertionName}`,
		);
		const mod = (await import(pathToFileURL(request.proverPath).href)) as {
			prove?: (ctx: unknown) => unknown | Promise<unknown>;
		};
		if (typeof mod.prove !== "function") {
			throw new Error(`prover ${formatPath(request.proverPath)} must export prove(ctx)`);
		}
		await mod.prove(session.ctx);
	} catch (err) {
		status = 1;
		error = err instanceof Error ? err.message : String(err);
		console.error(error);
	} finally {
		session.cleanup(status === 0);
		const result: ProverHostResult = {
			status,
			error,
			inputs: session.inputs(),
		};
		writeFileAtomic(request.resultPath, `${JSON.stringify(result, null, 2)}\n`);
	}

	if (status !== 0) process.exit(status);
}

function optionalScopeString(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!Object.hasOwn(value, key)) return undefined;
	const scalar = scalarToString(value[key]);
	if (scalar === undefined || scalar.trim() === "") {
		throw new Error(`invalid scope entry in ${label}: ${key} must be a non-empty string`);
	}
	return scalar;
}

function optionalScopeFlags(value: Record<string, unknown>, label: string): string[] {
	if (!Object.hasOwn(value, "flags")) return [];
	const raw = value.flags;
	if (!Array.isArray(raw))
		throw new Error(`invalid scope entry in ${label}: flags must be a YAML list`);
	return raw.map((entry) => {
		const flag = scalarToString(entry);
		if (!flag || flag.trim() === "")
			throw new Error(`invalid scope entry in ${label}: flags must contain non-empty strings`);
		return flag;
	});
}

function parseScopeRef(scope: unknown, path: string, index: number): ScopeRef {
	const label = `${path} scopes[${index}]`;
	if (typeof scope === "string") {
		throw new Error(
			`legacy scope shorthand is not supported in ${label}; use '- <repo-id>: { ... }' object form`,
		);
	}
	if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
		throw new Error(`invalid scope entry in ${label}: expected a one-key object`);
	}

	const keys = Object.keys(scope as Record<string, unknown>);
	if (keys.length !== 1) {
		throw new Error(`invalid scope entry in ${label}: expected exactly one repo id key`);
	}

	const repoId = keys[0]!.trim();
	if (!repoId) throw new Error(`invalid scope entry in ${label}: repo id key must be non-empty`);

	const rawValue = (scope as Record<string, unknown>)[repoId];
	if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
		throw new Error(`invalid scope entry in ${label}: value for '${repoId}' must be a YAML object`);
	}

	const value = rawValue as Record<string, unknown>;
	const ref = optionalScopeString(value, "ref", label);
	const pathValue = optionalScopeString(value, "path", label) ?? "";
	const mode = optionalScopeString(value, "mode", label);
	const render = optionalScopeString(value, "render", label) as "body" | "gist" | undefined;
	const flags = optionalScopeFlags(value, label);

	if (render && render !== "body" && render !== "gist") {
		throw new Error(`invalid scope entry in ${label}: render must be 'body' or 'gist'`);
	}
	if (mode && mode !== "ro" && mode !== "rw") {
		throw new Error(`invalid scope entry in ${label}: mode must be 'ro' or 'rw'`);
	}
	if (flags.some((flag) => flag === "body" || flag === "gist")) {
		throw new Error(`invalid scope entry in ${label}: body/gist must use render, not flags`);
	}

	const flagReadOnly = flags.includes("ro");
	if (mode === "rw" && flagReadOnly) {
		throw new Error(`invalid scope entry in ${label}: mode=rw conflicts with flags containing ro`);
	}

	if (repoId === ".") {
		if (ref) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set ref`);
		if (pathValue) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set path`);
		if (mode) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set mode`);
	}

	return {
		repoId,
		path: pathValue,
		ref,
		readOnly: mode ? mode === "ro" : flagReadOnly,
		flags,
		render,
	};
}

function parseScopeRefs(value: unknown, path: string): ScopeRef[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`invalid scopes in ${path}: expected a YAML list`);
	return value.map((scope, index) => parseScopeRef(scope, path, index));
}

function optionalLinkString(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!Object.hasOwn(value, key)) return undefined;
	const scalar = scalarToString(value[key]);
	if (scalar === undefined || scalar.trim() === "") {
		throw new Error(`invalid link entry in ${label}: ${key} must be a non-empty string`);
	}
	return scalar;
}

function parseLinkRef(link: unknown, path: string, index: number): LinkRef {
	const label = `${path} links[${index}]`;
	if (typeof link === "string") {
		const id = link.trim();
		if (!id) throw new Error(`invalid link entry in ${label}: id must be non-empty`);
		if (id.includes("#")) {
			throw new Error(
				`invalid link entry in ${label}: anchors are not allowed in string links; use '- <id>: { anchor: ... }'`,
			);
		}
		return { id };
	}
	if (!link || typeof link !== "object" || Array.isArray(link)) {
		throw new Error(
			`invalid link entry in ${label}: expected a bare id string or a one-key object`,
		);
	}

	const keys = Object.keys(link as Record<string, unknown>);
	if (keys.length !== 1) {
		throw new Error(`invalid link entry in ${label}: expected exactly one id key`);
	}

	const id = keys[0]!.trim();
	if (!id) throw new Error(`invalid link entry in ${label}: id key must be non-empty`);

	const rawValue = (link as Record<string, unknown>)[keys[0]!];
	if (rawValue === null || rawValue === undefined) return { id };
	if (typeof rawValue !== "object" || Array.isArray(rawValue)) {
		throw new Error(`invalid link entry in ${label}: value for '${id}' must be a YAML object`);
	}

	const value = rawValue as Record<string, unknown>;
	const rel = optionalLinkString(value, "rel", label);
	const anchor = optionalLinkString(value, "anchor", label);
	return { id, rel, anchor };
}

function parseLinkRefs(value: unknown, path: string): LinkRef[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`invalid links in ${path}: expected a YAML list`);
	return value.map((link, index) => parseLinkRef(link, path, index));
}

function defaultRender(kind: string): "body" | "gist" | undefined {
	if (kind === "foundation") return "body";
	if (
		kind === "convention" ||
		kind === "skill" ||
		kind === "runbook" ||
		kind === "assertion" ||
		kind === "decision"
	)
		return "gist";
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

		for (const scope of doc.scopes) {
			if (scope.repoId !== repoId) continue;

			const targetDir = scope.path ? resolve(repoRoot, scope.path) : repoRoot;
			if (!existsSync(targetDir)) {
				warnings.push(
					`scope path does not exist; skipping ${doc.relPath} -> ${repoLabel}/${scope.path}`,
				);
				continue;
			}

			const render = scope.render ?? renderDefault;
			const list = targets.get(targetDir) ?? [];
			if (
				!list.some(
					(item) =>
						item.doc.path === doc.path && item.render === render && item.scopePath === scope.path,
				)
			) {
				list.push({ doc, repoId, render, scopePath: scope.path, readOnly });
			}
			targets.set(targetDir, list);
		}
	}
}

function shouldGenerateWorkspaceDocs(bridge: BridgeConfig): boolean {
	return Boolean(bridge.workspaceDir && bridge.backlogDir && bridge.effortPath && bridge.effortRef);
}

function bridgeRunbookTargets(kbDocs: KbDoc[]): TargetDoc[] {
	const targets: TargetDoc[] = [];
	for (const doc of kbDocs) {
		if (doc.kind !== "runbook") continue;
		for (const scope of doc.scopes) {
			if (scope.repoId !== ".") continue;
			const render = scope.render ?? "gist";
			targets.push({ doc, repoId: "", render, scopePath: ".", readOnly: false });
			break;
		}
	}
	return targets;
}

function agentFilenames(agents: string[], warnings: string[]): string[] {
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

const FOUNDATION_FILTER_KEYS = [
	"include-if-any",
	"include-if-all",
	"exclude-if-any",
	"exclude-if-all",
] as const;

type FoundationFilterKey = (typeof FOUNDATION_FILTER_KEYS)[number];

function metaFilterTags(doc: KbDoc, key: FoundationFilterKey): string[] {
	const list = doc.metaLists[key];
	if (list && list.length > 0) return list.map((tag) => tag.trim()).filter(Boolean);
	const scalar = doc.metaScalars[key];
	return scalar ? [scalar.trim()].filter(Boolean) : [];
}

function selectedFoundationFilter(
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

function foundationFilterAllows(doc: KbDoc, tags: Set<string>, warnings: string[]): boolean {
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

function scopeMatchesAnyRepo(scope: ScopeRef, repoIds: Set<string>): boolean {
	return repoIds.has(scope.repoId);
}

function foundationBridgeTargets(options: {
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

function activeDiveRepos(dive: KbDoc | undefined): EffortRepo[] {
	if (!dive) return [];
	const repos = new Map<string, EffortRepo>();
	for (const scope of dive.scopes) {
		if (scope.repoId === ".") continue;
		if (!repos.has(scope.repoId))
			repos.set(scope.repoId, { id: scope.repoId, ref: scope.ref, readOnly: scope.readOnly });
	}
	return [...repos.values()];
}

function createApplyPlan(): ApplyPlan {
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

function applyDryRun(): void {
	const { bridge, repos, agentFiles, tags, targets, warnings } = createApplyPlan();

	console.log("nosedive apply --dry-run");
	console.log(`Bridge:    ${formatPath(bridge.bridgeDir)}`);
	console.log(
		`Workspace: ${bridge.workspaceDir ? formatPath(bridge.workspaceDir) : "(not configured)"}`,
	);
	console.log(
		`Backlog:   ${bridge.backlogDir ? formatPath(bridge.backlogDir) : "(not configured)"}`,
	);
	console.log(`KB:        ${formatPath(bridge.kbDir)}`);
	console.log(`Home:      ${bridge.homeBranch ?? "(not configured)"}`);
	console.log(`Work ref:  ${bridge.workBranchPrefix ?? "(not configured)"}`);
	console.log(`Pilot:     ${bridge.pilotName ?? "(no name)"} <${bridge.pilotEmail ?? "no email"}>`);
	console.log(`Effort:    ${bridge.effortRef ?? "(not configured)"}`);
	console.log(`Dive:      ${bridge.activeDiveId ?? "(not configured)"}`);
	console.log(`Tags:      ${tags.size > 0 ? [...tags].sort().join(", ") : "(none)"}`);
	console.log("");

	console.log("Bridge docs:");
	for (const filename of agentFiles)
		console.log(`  ${join(formatPath(bridge.bridgeDir), filename)}`);
	for (const item of (targets.get(bridge.bridgeDir) ?? []).sort((a, b) =>
		a.doc.relPath.localeCompare(b.doc.relPath),
	)) {
		console.log(`    - ${item.doc.relPath} :${item.render}`);
	}
	console.log("");

	if (repos.length > 0) {
		console.log("Repos:");
		for (const repo of repos) {
			const path = repo.repoPath ?? "(missing repo doc)";
			const mode = repo.readOnly ? "read-only" : "writable";
			const refSummary = repo.ref
				? `ref ${repo.repoRef} (base ${repo.repoBaseBranch})`
				: `base ${repo.repoBaseBranch}`;
			console.log(`  ${mode.padEnd(9)} ${path} (${repo.id}, ${refSummary})`);
		}
		console.log("");
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
	return [`## ${title}`, "", doc.gist || "(no gist)", "", `Source: \`${doc.relPath}\``, ""].join(
		"\n",
	);
}

function renderRunbookGistBlock(doc: KbDoc): string {
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

function withGeneratedEnvelope(
	filename: string,
	content: string,
	frontmatter?: GeneratedFrontmatter,
): string {
	const trimmed = content.replace(/^\n+/, "");
	return `${renderGeneratedFrontmatter(filename, frontmatter)}${trimmed}`;
}

function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(
		dirname(path),
		`.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

function writeAgentFiles(
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

function cleanGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of GIT_LOCAL_ENV_KEYS) delete env[key];
	return env;
}

function gitOutput(cwd: string, args: string[]): string | undefined {
	const result = runGit(cwd, args);
	if (result.status !== 0) return undefined;
	return result.stdout.trim();
}

function gitOk(cwd: string, args: string[]): boolean {
	return runGit(cwd, args).status === 0;
}

function executableForSpawn(command: string): string {
	if (process.platform === "win32" && (command === "npm" || command === "npx")) {
		return `${command}.cmd`;
	}
	return command;
}

function commandForSpawn(command: string, args: string[]): { command: string; args: string[] } {
	const resolvedCommand = executableForSpawn(command);
	if (
		process.platform === "win32" &&
		(resolvedCommand.endsWith(".cmd") || resolvedCommand.endsWith(".bat"))
	) {
		return {
			command: process.env.ComSpec || "cmd.exe",
			args: ["/d", "/s", "/c", resolvedCommand, ...args],
		};
	}
	return { command: resolvedCommand, args };
}

function spawnOutputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return "";
}

function gitCommonDir(cwd: string): string | undefined {
	const raw = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
	if (!raw) return undefined;
	return resolveFrom(cwd, raw);
}

function renderPackageKbBody(id: string): string {
	if (!uuidLike(id)) throw new Error(`render requires a UUID-shaped id: ${id}`);
	const docPath = join(packageRoot(), "kb", `${id}.md`);
	if (!existsSync(docPath)) throw new Error(`package kb doc not found: ${id}`);
	if (!statSync(docPath).isFile()) throw new Error(`package kb doc is not a file: ${id}`);
	return parseMarkdownDoc(readFileSync(docPath, "utf8"), docPath).body;
}

function renderCommand(args: string[]): void {
	const [id, ...extra] = args;
	if (!id || extra.length > 0) throw new Error("render requires exactly one uuid");
	process.stdout.write(renderPackageKbBody(id));
}

function printManualHookAdvice(reason: string): void {
	console.error(`WARNING: ${reason}`);
	console.error("Add this line to your existing pre-push hook setup:");
	console.error(`  ${MANUAL_PRE_PUSH_LINE}`);
}

function preflight(_args: string[]): void {
	const rc = readNosediveRc(process.cwd());
	const hooksPath = gitOutput(rc.bridgeDir, ["config", "--get", "core.hooksPath"]);
	if (hooksPath) {
		printManualHookAdvice(
			`core.hooksPath is set to ${hooksPath}; nosedive will not change it or write an ignored .git/hooks/pre-push.`,
		);
		return;
	}

	const commonDir = gitCommonDir(rc.bridgeDir);
	if (!commonDir) throw new Error("nosedive preflight must be run inside a git-backed bridge");
	const hookPath = join(commonDir, "hooks", "pre-push");
	if (existsSync(hookPath)) {
		const existing = readFileSync(hookPath, "utf8");
		if (!existing.includes("nosedive-managed")) {
			printManualHookAdvice(
				`foreign pre-push hook exists at ${formatPath(hookPath)}; leaving it unchanged.`,
			);
			return;
		}
	}

	mkdirSync(dirname(hookPath), { recursive: true });
	writeFileAtomic(hookPath, PRE_PUSH_HOOK);
	chmodSync(hookPath, 0o755);
	console.log(`Installed nosedive pre-push hook: ${formatPath(hookPath)}`);
}

interface WorkspaceDiveMarker {
	present: boolean;
	id?: string;
	error?: string;
}

function readWorkspaceDiveMarker(workspaceDir: string | undefined): WorkspaceDiveMarker {
	if (!workspaceDir) return { present: false };
	const markerPath = join(workspaceDir, ".nosedive-ref");
	if (!existsSync(markerPath)) return { present: false };
	try {
		const marker = parseYamlBlock(readFileSync(markerPath, "utf8"), markerPath);
		const id = marker.scalars.id?.trim();
		if (!id) return { present: true, error: `${formatPath(markerPath)} is missing id` };
		if (!uuidLike(id))
			return { present: true, error: `${formatPath(markerPath)} id is not UUID-shaped` };
		return { present: true, id };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { present: true, error: detail };
	}
}

interface DiveWipScope {
	repoId: string;
	ref?: string;
	readOnly: boolean;
}

interface DiveWipFailure {
	repoId?: string;
	repoPath?: string;
	readOnly?: boolean;
	reasons: string[];
}

function uniqueDiveWipScopes(scopes: ScopeRef[]): {
	scopes: DiveWipScope[];
	failures: DiveWipFailure[];
} {
	const byRepo = new Map<string, DiveWipScope>();
	const failures: DiveWipFailure[] = [];

	for (const scope of scopes) {
		if (scope.repoId === ".") continue;
		const existing = byRepo.get(scope.repoId);
		if (!existing) {
			byRepo.set(scope.repoId, {
				repoId: scope.repoId,
				ref: scope.ref,
				readOnly: scope.readOnly,
			});
			continue;
		}
		if (existing.ref && scope.ref && existing.ref !== scope.ref) {
			failures.push({
				repoId: scope.repoId,
				reasons: [`conflicting pinned refs in active dive: ${existing.ref} and ${scope.ref}`],
			});
		}
		if (!existing.ref) existing.ref = scope.ref;
		existing.readOnly = existing.readOnly && scope.readOnly;
	}

	return { scopes: [...byRepo.values()], failures };
}

function hydratedScopedRepoPath(
	kbDocs: KbDoc[],
	scope: DiveWipScope,
	bridgeDir: string,
	workspaceDir: string,
): { path?: string; failure?: DiveWipFailure } {
	const repoDoc = maybeResolveRepoDoc(kbDocs, scope.repoId);
	if (!repoDoc) {
		return {
			failure: {
				repoId: scope.repoId,
				readOnly: scope.readOnly,
				reasons: ["active dive scope names a repo with no kb repo doc; cannot check WIP"],
			},
		};
	}

	let targetPath: string;
	try {
		targetPath = expectedWorktreePath(repoDoc, bridgeDir);
		ensureSafeTargetPath(scope.repoId, targetPath, workspaceDir);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			failure: {
				repoId: scope.repoId,
				readOnly: scope.readOnly,
				reasons: [detail],
			},
		};
	}

	if (!existsSync(targetPath)) return {};
	if (!statSync(targetPath).isDirectory()) {
		return {
			failure: {
				repoId: scope.repoId,
				repoPath: targetPath,
				readOnly: scope.readOnly,
				reasons: ["hydrated repo path exists but is not a directory"],
			},
		};
	}
	if (!gitOutput(targetPath, ["rev-parse", "--show-toplevel"])) return {};
	return { path: targetPath };
}

function checkScopedRepoWip(scope: DiveWipScope, repoPath: string): DiveWipFailure | undefined {
	const reasons: string[] = [];
	const status = gitOutput(repoPath, ["status", "--porcelain"]);
	if (status === undefined) {
		reasons.push("could not read git status");
	} else if (status.trim() !== "") {
		reasons.push("dirty worktree");
	}

	if (!scope.ref) {
		reasons.push("active dive scope is missing a pinned ref");
	} else {
		const ahead = gitOutput(repoPath, ["rev-list", `${scope.ref}..HEAD`]);
		if (ahead === undefined) {
			reasons.push(`could not compare ${scope.ref}..HEAD`);
		} else if (ahead.trim() !== "") {
			reasons.push(`commits ahead of pinned ref ${scope.ref}`);
		}
	}

	if (reasons.length === 0) return undefined;
	return { repoId: scope.repoId, repoPath, readOnly: scope.readOnly, reasons };
}

function checkDiveWip(): DiveWipFailure[] {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) return [];

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) return [];
	if (marker.error || !marker.id) {
		return [{ reasons: [`broken active dive marker: ${marker.error ?? "missing id"}`] }];
	}

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const activeDive = kbDocs.find((doc) => doc.kind === "dive" && doc.id === marker.id);
	if (!activeDive) {
		return [{ reasons: [`broken active dive marker: no kind: dive doc found for ${marker.id}`] }];
	}

	const { scopes, failures } = uniqueDiveWipScopes(activeDive.scopes);
	for (const scope of scopes) {
		const scopedPath = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (scopedPath.failure) {
			failures.push(scopedPath.failure);
			continue;
		}
		if (!scopedPath.path) continue;
		const failure = checkScopedRepoWip(scope, scopedPath.path);
		if (failure) failures.push(failure);
	}

	return failures;
}

function printDiveWipFailure(failures: DiveWipFailure[]): void {
	console.error("Push failed because the active dive has not been handed off.");
	console.error("");
	for (const failure of failures) {
		const subject = failure.repoId
			? `${failure.readOnly ? "read-only scoped repo" : "scoped repo"} ${failure.repoId}${failure.repoPath ? ` at ${formatPath(failure.repoPath)}` : ""}`
			: "active dive";
		console.error(`- ${subject}: ${failure.reasons.join("; ")}`);
		if (failure.readOnly) {
			console.error(
				"  This read-only scope still contains work to preserve; consider re-scoping it writable.",
			);
		}
	}
	console.error("");
	console.error(`Handoff runbook: ${HANDOFF_RUNBOOK_ID}`);
	console.error("HINT: To learn more, run:");
	console.error(`  npx nosedive render ${HANDOFF_RUNBOOK_ID}`);
}

function prePushHook(_args: string[]): void {
	const failures = checkDiveWip();
	if (failures.length === 0) return;
	printDiveWipFailure(failures);
	process.exit(1);
}

function gitRelPath(repoRoot: string, path: string): string {
	return relative(repoRoot, path).replaceAll("\\", "/");
}

interface ManagedExcludeSpec {
	begin: string;
	end: string;
	header: string[];
}

const AGENT_EXCLUDE_SPEC: ManagedExcludeSpec = {
	begin: MANAGED_EXCLUDE_BEGIN,
	end: MANAGED_EXCLUDE_END,
	header: [
		"# kb: 019f5651-5539-76f5-b6bd-351d300194eb",
		"# name: nosedive-managed-local-git-state",
		"# owner: nosedive apply",
		"# reason: generated bridge agent instruction files are local artifacts",
	],
};

const FOUNDATION_EXCLUDE_SPEC: ManagedExcludeSpec = {
	begin: FOUNDATION_EXCLUDE_BEGIN,
	end: FOUNDATION_EXCLUDE_END,
	header: [
		"# owner: nosedive init",
		"# reason: .nosedive.local.yaml and package foundation docs are local bootstrap artifacts",
	],
};

const REPO_MARKER_EXCLUDE_SPEC: ManagedExcludeSpec = {
	begin: REPO_MARKER_EXCLUDE_BEGIN,
	end: REPO_MARKER_EXCLUDE_END,
	header: [
		"# owner: nosedive hydrate-repo.workspace",
		"# reason: repo ownership marker is local workspace state",
	],
};

function removeManagedExcludeBlocks(text: string, spec: ManagedExcludeSpec): string {
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (lines[i] !== spec.begin) {
			out.push(lines[i]);
			continue;
		}

		const end = lines.indexOf(spec.end, i + 1);
		if (end === -1) {
			out.push(lines[i]);
			continue;
		}
		i = end;
	}
	return out.join("\n").replace(/\n*$/, "\n");
}

function renderManagedExcludeBlock(filenames: string[], spec: ManagedExcludeSpec): string {
	return [spec.begin, ...spec.header, ...filenames, spec.end].join("\n");
}

function replaceManagedExcludeBlock(
	text: string,
	filenames: string[],
	spec: ManagedExcludeSpec,
): string {
	const withoutManaged = removeManagedExcludeBlocks(text, spec);
	const prefix = withoutManaged.trim() ? `${withoutManaged.replace(/\n*$/, "\n")}\n` : "";
	return `${prefix}${renderManagedExcludeBlock(filenames, spec)}\n`;
}

function updateManagedExclude(
	repoRoot: string,
	filenames: string[],
	warnings: string[],
	spec: ManagedExcludeSpec,
): void {
	const rawExcludePath = gitOutput(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
	if (!rawExcludePath) {
		warnings.push(`could not resolve git exclude path for ${repoRoot}`);
		return;
	}

	const excludePath = isAbsolute(rawExcludePath)
		? rawExcludePath
		: resolve(repoRoot, rawExcludePath);
	const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	writeFileAtomic(excludePath, replaceManagedExcludeBlock(existing, filenames, spec));
}

function manageGitState(paths: string[], spec: ManagedExcludeSpec): string[] {
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
		const filenames = [...new Set(files.map((file) => gitRelPath(repoRoot, file)))];
		updateManagedExclude(repoRoot, filenames, warnings, spec);

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

function manageGeneratedGitState(paths: string[]): string[] {
	return manageGitState(paths, AGENT_EXCLUDE_SPEC);
}

function manageFoundationGitState(paths: string[]): string[] {
	return manageGitState(paths, FOUNDATION_EXCLUDE_SPEC);
}

function managedExcludeEntries(text: string, spec: ManagedExcludeSpec): string[] {
	const entries: string[] = [];
	const lines = text.split(/\r?\n/);

	for (let i = 0; i < lines.length; i += 1) {
		if (lines[i] !== spec.begin) continue;

		const end = lines.indexOf(spec.end, i + 1);
		if (end === -1) continue;

		for (let j = i + 1; j < end; j += 1) {
			const entry = lines[j]?.trim() ?? "";
			if (!entry || entry.startsWith("#")) continue;
			entries.push(entry);
		}

		i = end;
	}

	return [...new Set(entries)];
}

function nukeInstructions(): void {
	const bridge = loadBridgeConfig(process.cwd());
	const repoRoot = gitOutput(bridge.bridgeDir, ["rev-parse", "--show-toplevel"]);
	if (!repoRoot) throw new Error("nosedive nuke must be run inside a git-backed bridge");

	const warnings: string[] = [];
	let revertedFiles = 0;

	const rawExcludePath = gitOutput(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
	if (!rawExcludePath) {
		warnings.push(`could not resolve git exclude path for ${repoRoot}`);
	} else {
		const excludePath = isAbsolute(rawExcludePath)
			? rawExcludePath
			: resolve(repoRoot, rawExcludePath);
		const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
		const managedEntries = managedExcludeEntries(existing, AGENT_EXCLUDE_SPEC);

		for (const rel of managedEntries) {
			if (!gitOk(repoRoot, ["ls-files", "--error-unmatch", "--", rel])) continue;

			if (!gitOk(repoRoot, ["update-index", "--no-skip-worktree", "--", rel])) {
				warnings.push(`could not clear skip-worktree: ${join(repoRoot, rel)}`);
				continue;
			}

			if (!gitOk(repoRoot, ["checkout", "--", rel])) {
				warnings.push(`could not restore tracked file from git: ${join(repoRoot, rel)}`);
				continue;
			}

			revertedFiles += 1;
		}

		const withoutManaged = removeManagedExcludeBlocks(existing, AGENT_EXCLUDE_SPEC);
		if (withoutManaged !== existing) writeFileAtomic(excludePath, withoutManaged);
	}

	console.log(
		`Nuked managed instruction state in bridge repo; reverted ${revertedFiles} tracked file${revertedFiles === 1 ? "" : "s"}.`,
	);
	if (warnings.length > 0) {
		console.log("");
		console.log("Warnings:");
		for (const warning of warnings) console.log(`  - ${warning}`);
	}
}

interface NukeOptions {
	help: boolean;
	instructions: boolean;
}

function parseNukeOptions(args: string[]): NukeOptions {
	const options: NukeOptions = { help: false, instructions: false };
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg === "--instructions") {
			options.instructions = true;
			continue;
		}
		throw new Error(`unknown nuke option: ${arg}`);
	}
	return options;
}

function nuke(args: string[]): void {
	const options = parseNukeOptions(args);
	if (options.help) {
		console.log("Usage: nosedive nuke --instructions");
		console.log("  Reset managed instruction-file git state to factory defaults.");
		return;
	}

	if (!options.instructions) {
		throw new Error("nosedive nuke is destructive; rerun with --instructions");
	}

	nukeInstructions();
}

function repoFrontmatter(
	bridge: BridgeConfig,
	docs: TargetDoc[],
): GeneratedFrontmatter | undefined {
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

	generatedFiles.push(
		...writeAgentFiles(
			plan.bridge.bridgeDir,
			plan.agentFiles,
			renderRepoDoc(plan.bridge.bridgeDir, plan.targets.get(plan.bridge.bridgeDir) ?? []),
		),
	);

	plan.warnings.push(...manageGeneratedGitState(generatedFiles));

	console.log(
		`Wrote bridge docs: ${plan.agentFiles.map((filename) => join(formatPath(plan.bridge.bridgeDir), filename)).join(", ")}`,
	);
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
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
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
		case "preflight":
			preflight(args);
			break;
		case "prove":
			await prove(args);
			break;
		case "__prove-host":
			await proveHost(args);
			break;
		case "render":
			renderCommand(args);
			break;
		case "pre-push.hook":
			prePushHook(args);
			break;
		case "whoami":
			whoami(args);
			break;
		case "dump-backlog":
			dumpBacklog(args);
			break;
		case "list-dives":
			listDives(args);
			break;
		case "pitch":
			pitch(args);
			break;
		case "add-repo":
			addRepo(args);
			break;
		case "hydrate-repo.workspace":
			hydrateRepoWorkspace(args);
			break;
		case "dehydrate-repo.workspace":
			dehydrateRepoWorkspace(args);
			break;
		case "apply":
			apply(args);
			break;
		case "nuke":
			nuke(args);
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
