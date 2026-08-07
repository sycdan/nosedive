import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { UUID7_MAX_TIMESTAMP_MS, uuid7AtMs } from "./uuid7.js";

import { CURRENT_COMPATIBILITY_LEVEL, DEFAULT_RC } from "./constants.js";
import {
	RcSettings,
	SeedOptions,
	baseConfigPath,
	emptyYaml,
	formatPath,
	legacyConfigPath,
	parseMarkdownDoc,
	parseYamlBlock,
	toPosixPath,
} from "./coreParsing.js";
import { packageMigrationDocs, packageMigrations, packageRoot } from "./packageBacklog.js";
import { gitOutput } from "./renderPlan.js";

export function parseSeedOptions(args: string[]): SeedOptions {
	const options: SeedOptions = { help: false, headless: false, files: [] };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg === "--headless") {
			options.headless = true;
			continue;
		}
		if (arg === "--file" || arg.startsWith("--file=")) {
			const value = arg === "--file" ? args[++i] : arg.slice("--file=".length);
			if (!value) throw new Error("seed --file requires a path");
			options.files.push(value);
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown seed option: ${arg}`);
		throw new Error(`unexpected seed argument: ${arg}`);
	}
	return options;
}

/** Load effective settings from the split config shape at `bridgeDir`, defaulting missing fields. */
export function loadSplitRcSettings(bridgeDir: string): RcSettings {
	const basePath = baseConfigPath(bridgeDir);
	const base = existsSync(basePath)
		? parseYamlBlock(readFileSync(basePath, "utf8"), formatPath(basePath))
		: emptyYaml();

	return {
		workspace: base.scalars.workspace ?? DEFAULT_RC.workspace,
		backlog: base.scalars.backlog ?? DEFAULT_RC.backlog,
		kb: base.scalars.kb ?? DEFAULT_RC.kb,
		homeBranch: base.scalars["home-branch"] ?? DEFAULT_RC["home-branch"],
		workBranchPrefix: base.scalars["work-branch-prefix"] ?? DEFAULT_RC["work-branch-prefix"],
		pilotName: "",
		pilotEmail: "",
		extra: unownedConfigScalars(base.scalars),
	};
}

/** Config keys seed writes itself; everything else is the pilot's and is preserved. */
const SEEDED_CONFIG_KEYS = new Set([
	"compatibility-level",
	"workspace",
	"backlog",
	"kb",
	"home-branch",
	"work-branch-prefix",
]);

export function unownedConfigScalars(scalars: Record<string, string>): Record<string, string> {
	const extra: Record<string, string> = {};
	for (const [key, value] of Object.entries(scalars)) {
		if (!SEEDED_CONFIG_KEYS.has(key)) extra[key] = value;
	}
	return extra;
}

export function renderBaseConfig(settings: RcSettings, compatibilityLevel: number): string {
	return [
		`compatibility-level: ${compatibilityLevel}`,
		`workspace: ${toPosixPath(settings.workspace)}`,
		`backlog: ${toPosixPath(settings.backlog)}`,
		`kb: ${toPosixPath(settings.kb)}`,
		`home-branch: ${settings.homeBranch}`,
		`work-branch-prefix: ${settings.workBranchPrefix}`,
		...Object.entries(settings.extra).map(([key, value]) => `${key}: ${value}`),
		"",
	].join("\n");
}

// --- migrations ----------------------------------------------------------

export interface MigrationContext {
	bridgeDir: string;
	mintUuid: () => string;
}

export interface Migration {
	fromLevel: number;
	toLevel: number;
	/** kind: migration kb doc id, read from the package (never seeded into a bridge's kb) for error output. */
	docId: string;
	/** Script artifact path, relative to the installed package root. */
	scriptRelPath: string;
	/** Short human-facing description, mirrors the doc's gist, for log/error output. */
	summary: string;
}

export interface MigrationRunSummary {
	sourceDir?: string;
	copiedFiles?: string[];
	effortCount?: number;
	featCount?: number;
	backlogMemoId?: string;
	bridgeRepo?: {
		id?: string;
		status?: string;
		remotes?: string[];
	};
	manualCleanup?: string;
}

export type ConfigShapeInfo =
	| { kind: "none" }
	| { kind: "legacy" }
	| { kind: "split"; version: number }
	| { kind: "split-unversioned" }
	| { kind: "ambiguous" };

/** Detect config shape in `bridgeDir` only -- seed never considers ancestor directories. */
export function detectConfigShapeAt(bridgeDir: string): ConfigShapeInfo {
	const hasBase = existsSync(baseConfigPath(bridgeDir));
	const hasLegacy = existsSync(legacyConfigPath(bridgeDir));

	if (hasBase && hasLegacy) return { kind: "ambiguous" };
	if (hasBase) {
		const basePath = baseConfigPath(bridgeDir);
		const base = parseYamlBlock(readFileSync(basePath, "utf8"), formatPath(basePath));
		const raw = base.scalars["compatibility-level"];
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
export function describeMigrationForError(docId: string): string {
	const doc = packageMigrationDocs().find((d) => d.filename === `${docId}.md`);
	if (!doc) return `(kind: migration doc ${docId} not found in the installed nosedive package)`;
	const parsed = parseMarkdownDoc(doc.content, doc.filename);
	const gist = parsed.fm.scalars.gist;
	const body = parsed.body.trim();
	return [gist, "", body].filter((line): line is string => line !== undefined).join("\n");
}

export function migrationDocPath(migration: Migration): string {
	return join(packageRoot(), "kb", `${migration.docId}.md`);
}

export function createUuid7Minter(): () => string {
	let lastMs = 0;
	return () => {
		const now = Math.max(Date.now(), lastMs + 1);
		lastMs = now;
		if (now > UUID7_MAX_TIMESTAMP_MS) throw new Error("mint: timestamp out of UUIDv7 range");
		return uuid7AtMs(now);
	};
}

export async function runMigration(
	migration: Migration,
	ctx: MigrationContext,
): Promise<MigrationRunSummary | undefined> {
	const scriptPath = join(packageRoot(), migration.scriptRelPath);
	const mod = (await import(pathToFileURL(scriptPath).href)) as {
		migrate?: (ctx: MigrationContext) => void | MigrationRunSummary;
	};
	if (typeof mod.migrate !== "function")
		throw new Error(`migration script ${migration.scriptRelPath} does not export migrate()`);
	return mod.migrate(ctx) ?? undefined;
}

export function hasLegacyBacklogContent(bridgeDir: string): boolean {
	return ["backlog", "efforts"].some((name) => {
		const path = join(bridgeDir, name);
		return existsSync(path) && statSync(path).isDirectory();
	});
}

export function printMigrationSummary(
	io: CommandIo,
	migration: Migration,
	summary: MigrationRunSummary,
): void {
	io.log(`Migration ${migration.docId} complete.`);
	if (summary.sourceDir) io.log(`Source: ${toPosixPath(summary.sourceDir)}`);
	if (summary.effortCount !== undefined) io.log(`Efforts copied: ${summary.effortCount}`);
	if (summary.featCount !== undefined) io.log(`Feats migrated: ${summary.featCount}`);
	if (summary.backlogMemoId) io.log(`Backlog memo: ${summary.backlogMemoId}`);
	if (summary.bridgeRepo?.id) {
		const status = summary.bridgeRepo.status ? `${summary.bridgeRepo.status} ` : "";
		io.log(`Bridge repo: ${status}${summary.bridgeRepo.id}`);
	}
	if (summary.copiedFiles && summary.copiedFiles.length > 0) {
		io.log("Copied files:");
		for (const file of summary.copiedFiles) io.log(`  - ${toPosixPath(file)}`);
	}
	if (summary.manualCleanup) io.log(summary.manualCleanup);
}

/**
 * Run every pending migration for `bridgeDir`, in order, failing loudly (with
 * no partial writes for the blocking step) on any unrecognized/ambiguous
 * shape or migration failure. Returns quickly with no I/O beyond the shape
 * check when the bridge is already current.
 */
export async function migrateBridgeConfig(bridgeDir: string, io: CommandIo): Promise<void> {
	const shape = detectConfigShapeAt(bridgeDir);

	if (shape.kind === "ambiguous") {
		throw new Error(
			`bridge config is ambiguous: both ${formatPath(legacyConfigPath(bridgeDir))} and ` +
				`${formatPath(baseConfigPath(bridgeDir))} exist. Remove ${formatPath(legacyConfigPath(bridgeDir))} manually before running seed again.`,
		);
	}
	if (shape.kind === "split-unversioned") {
		throw new Error(
			`${formatPath(baseConfigPath(bridgeDir))} exists but has no readable compatibility-level; ` +
				`refusing to guess its migration state. Fix or remove it manually before running seed again.`,
		);
	}

	let version =
		shape.kind === "legacy" || (shape.kind === "none" && hasLegacyBacklogContent(bridgeDir))
			? 0
			: shape.kind === "none"
				? CURRENT_COMPATIBILITY_LEVEL
				: shape.version;
	if (version === CURRENT_COMPATIBILITY_LEVEL) return; // already current: no-op, no further I/O

	const ctx: MigrationContext = { bridgeDir, mintUuid: createUuid7Minter() };
	const migrations = packageMigrations();
	while (version < CURRENT_COMPATIBILITY_LEVEL) {
		const migration = migrations.find((m) => m.fromLevel === version);
		if (!migration) {
			const known = migrations
				.map((m) => `  L${m.fromLevel}->L${m.toLevel}: ${m.summary}`)
				.join("\n");
			throw new Error(
				`no migration path from compatibility level ${version} to ${CURRENT_COMPATIBILITY_LEVEL}; ` +
					`bridge config is in an unrecognized state.\nKnown migrations:\n${known}`,
			);
		}

		try {
			io.log(`Running migration ${formatPath(migrationDocPath(migration))}...`);
			const summary = await runMigration(migration, ctx);
			if (summary) printMigrationSummary(io, migration, summary);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(
				`migration '${migration.summary}' (L${migration.fromLevel}->L${migration.toLevel}) failed: ${detail}\n\n` +
					describeMigrationForError(migration.docId),
			);
		}

		version = migration.toLevel;
	}
}

export function loadGitPilotIdentity(
	bridgeDir: string,
): Pick<RcSettings, "pilotName" | "pilotEmail"> {
	return {
		pilotName: gitOutput(bridgeDir, ["config", "user.name"]) ?? "",
		pilotEmail: gitOutput(bridgeDir, ["config", "user.email"]) ?? "",
	};
}

export type LineIterator = NodeJS.AsyncIterator<string>;

// --- command io ------------------------------------------------------------

/**
 * Commands write through a `CommandIo` instead of touching `console` or
 * `process` directly, so one implementation can serve the builtin dispatch
 * path while another captures the same output for a command adapter.
 */
export interface CommandIo {
	/** Write one stdout line. */
	log(message?: string): void;
	/** Write one stderr line. */
	err(message: string): void;
	/** Write raw stdout text, adding no newline. For replaying captured child output. */
	writeOut(text: string): void;
	/** Write raw stderr text, adding no newline. */
	writeErr(text: string): void;
	/**
	 * Write `label` with no trailing newline and read one trimmed reply line,
	 * or `undefined` once stdin reaches EOF.
	 */
	prompt(label: string): Promise<string | undefined>;
	setExitCode(code: number): void;
	/** Release any stdin reader this io opened. */
	close(): void;
}

/**
 * Piped (non-TTY) stdin delivers every buffered line the instant the stream
 * is first resumed, but `rl.question()` only ever attaches a listener for
 * one line at a time -- every line after the first gets silently dropped,
 * and the next question then hangs waiting on an already-EOF'd stream.
 * Driving the interface's async iterator directly instead consumes lines
 * one at a time regardless of how they arrived.
 */
export async function nextLine(iter: LineIterator): Promise<string | undefined> {
	const { value, done } = await iter.next();
	return done ? undefined : value.trim();
}

/**
 * Prompting always goes straight to the real stdio, even for a capturing io:
 * a buffered prompt would never reach the terminal before its own reply is
 * read. Every command that prompts finishes prompting before it writes any
 * result line, so this never interleaves with captured output.
 */
export function createStdinPrompter(): { prompt: CommandIo["prompt"]; close: () => void } {
	let iter: LineIterator | undefined;
	let rl: ReturnType<typeof createInterface> | undefined;
	return {
		async prompt(label: string): Promise<string | undefined> {
			if (!iter) {
				rl = createInterface({ input: process.stdin, output: process.stdout });
				iter = rl[Symbol.asyncIterator]();
			}
			process.stdout.write(label);
			return nextLine(iter);
		},
		close(): void {
			rl?.close();
			rl = undefined;
			iter = undefined;
		},
	};
}

/** Io for the builtin dispatch path: straight through to the real stdio. */
export function createConsoleIo(): CommandIo {
	const prompter = createStdinPrompter();
	return {
		log(message = ""): void {
			console.log(message);
		},
		err(message: string): void {
			console.error(message);
		},
		writeOut(text: string): void {
			process.stdout.write(text);
		},
		writeErr(text: string): void {
			process.stderr.write(text);
		},
		prompt: prompter.prompt,
		setExitCode(code: number): void {
			process.exitCode = code;
		},
		close: prompter.close,
	};
}

export interface CapturedCommandOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface CapturingCommandIo extends CommandIo {
	captured(): CapturedCommandOutput;
}

/** Io for command adapters: buffers stdout/stderr so the host can return it. */
export function createCapturingIo(): CapturingCommandIo {
	const prompter = createStdinPrompter();
	let stdout = "";
	let stderr = "";
	let exitCode = 0;
	return {
		log(message = ""): void {
			stdout += `${message}\n`;
		},
		err(message: string): void {
			stderr += `${message}\n`;
		},
		writeOut(text: string): void {
			stdout += text;
		},
		writeErr(text: string): void {
			stderr += text;
		},
		prompt: prompter.prompt,
		setExitCode(code: number): void {
			exitCode = code;
		},
		close: prompter.close,
		captured(): CapturedCommandOutput {
			return { stdout, stderr, exitCode };
		},
	};
}

export async function promptScalar(io: CommandIo, label: string, current: string): Promise<string> {
	const line = await io.prompt(`${label} [${current}]: `);
	return !line ? current : line;
}
