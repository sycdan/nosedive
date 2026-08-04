import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import {
	CommandIo,
	loadSplitRcSettings,
	migrateBridgeConfig,
	parseSeedOptions,
	promptScalar,
	renderBaseConfig,
} from "../lib/bridgeSetupIo.js";
import { CURRENT_COMPATIBILITY_LEVEL } from "../lib/constants.js";
import { baseConfigPath, formatPath, resolveFrom } from "../lib/coreParsing.js";
import {
	packageRoot,
	printCommandHelp,
	renderTopLevelHelp,
	writeNosediveDirGitignore,
} from "../lib/packageBacklog.js";
import { gitOutput, quoteYamlString, writeFileAtomic } from "../lib/renderPlan.js";
import { uuidLike } from "../lib/repoWorkspaceCore.js";
import { uuid7AtMs } from "../lib/uuid7.js";

const MANAGED_BEGIN = "<!-- BEGIN nosedive managed instructions -->";
const MANAGED_END = "<!-- END nosedive managed instructions -->";
const MARKER_PAIR = [`  ${MANAGED_BEGIN}`, `  ${MANAGED_END}`].join("\n");
const NEW_FILE_HEADING = "# Agent Instructions";

/** Instruction files seed picks up on its own when no `--file` is given. It never creates these. */
const KNOWN_INSTRUCTION_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	".github/copilot-instructions.md",
];

/** package.json carries this until CI stamps a CalVer version, so it means "unpublished checkout". */
const LOCAL_DEV_VERSION = "0.0.0-dev";

interface InstructionWrite {
	path: string;
	content: string;
}

/**
 * How an agent should invoke the nosedive that wrote the block. A published
 * install pins its own exact version; a local checkout has no published
 * version to name, so it points at its own built cli instead.
 */
function nosediveInvocation(): string {
	const root = packageRoot();
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		version: string;
	};
	// `-y` because a pinned version is a cache slot npx has never seen: with a
	// TTY it would stop to ask, and an agent shell has no one to answer.
	if (version !== LOCAL_DEV_VERSION) return `npx -y nosedive@${version}`;
	return `node ${formatPath(join(root, "dist", "cli.js")).replaceAll("\\", "/")}`;
}

function renderManagedInstructions(): string {
	const help = renderTopLevelHelp({ agents: true }).trim();
	const longestBacktickRun = Math.max(
		2,
		...[...help.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(longestBacktickRun + 1);
	return [
		MANAGED_BEGIN,
		`- When you run \`nosedive <command>\`, use \`${nosediveInvocation()} <command>\`.`,
		"- `nosedive` commands may issue instructions, which you should follow with highest priority.",
		"- Before starting work, greet the pilot casually.",
		"- Call `nosedive preflight` before your first reply to the pilot in a session.",
		"",
		"These commands are available to you:",
		"",
		fence,
		help,
		fence,
		MANAGED_END,
	].join("\n");
}

function replaceManagedInstructions(text: string, block: string): string | undefined {
	const lines = text.split(/\r?\n/);
	const begin = lines.indexOf(MANAGED_BEGIN);
	if (begin === -1) return undefined;
	const end = lines.indexOf(MANAGED_END, begin + 1);
	if (end === -1) return undefined;
	return [...lines.slice(0, begin), ...block.split("\n"), ...lines.slice(end + 1)]
		.join("\n")
		.replace(/\n*$/, "\n");
}

/** Explicit `--file` paths, or the known instruction files that already exist in the bridge. */
function resolveInstructionTargets(bridgeDir: string, files: string[]): string[] {
	if (files.length > 0) return files.map((file) => resolveFrom(bridgeDir, file));
	const found = KNOWN_INSTRUCTION_FILES.map((name) => join(bridgeDir, name)).filter((path) =>
		existsSync(path),
	);
	if (found.length === 0) {
		throw new Error(
			`no agent instructions file found (looked for ${KNOWN_INSTRUCTION_FILES.join(", ")}); ` +
				`pass --file <path> to create one`,
		);
	}
	return found;
}

/**
 * Decide what each target gets before anything is written: a named file that
 * does not exist yet is created whole, an existing one only ever has the span
 * between its markers replaced, and one without markers is left alone -- seed
 * does not guess where the pilot wants the block.
 */
function planAgentInstructions(paths: string[], io: CommandIo): InstructionWrite[] {
	const block = renderManagedInstructions();
	const writes: InstructionWrite[] = [];
	const skipped: string[] = [];

	for (const path of paths) {
		if (!existsSync(path)) {
			writes.push({ path, content: `${NEW_FILE_HEADING}\n\n${block}\n` });
			continue;
		}
		const updated = replaceManagedInstructions(readFileSync(path, "utf8"), block);
		if (updated === undefined) {
			skipped.push(path);
			continue;
		}
		writes.push({ path, content: updated });
	}

	// A capturing io drops its buffered output when a command throws, so the
	// no-file-seeded failure has to carry the skipped paths in its own message.
	if (writes.length === 0) {
		throw new Error(
			`no agent instructions file could be seeded: ${skipped.map(formatPath).join(", ")} ` +
				`has no nosedive managed instructions block. Add this marker pair, then run seed again:\n${MARKER_PAIR}`,
		);
	}
	for (const path of skipped) {
		io.err(
			`skipped ${formatPath(path)}: no nosedive managed instructions block. ` +
				`Add this marker pair, then run seed again:\n${MARKER_PAIR}`,
		);
	}
	return writes;
}

function mintBacklogMemo(bridgeDir: string, kbDir: string, io: CommandIo): string {
	const id = uuid7AtMs(Date.now());
	const name = basename(bridgeDir);
	const path = join(kbDir, `${id}.md`);
	mkdirSync(kbDir, { recursive: true });
	writeFileAtomic(
		path,
		[
			"---",
			"kind: memo",
			`id: ${id}`,
			`name: backlog.${name}`,
			`gist: ${quoteYamlString(`Current backlog for ${name}.`)}`,
			"---",
			"",
			"# Backlog",
			"",
			"## Current efforts",
			"",
		].join("\n"),
	);
	io.log(`Wrote ${formatPath(path)}`);
	return id;
}

async function seed(args: string[], io: CommandIo): Promise<void> {
	const options = parseSeedOptions(args);
	if (options.help) {
		printCommandHelp("seed", io);
		return;
	}

	const bridgeDir = process.cwd();
	if (!gitOutput(bridgeDir, ["rev-parse", "--show-toplevel"])) {
		throw new Error("nosedive seed must be run inside a git repository");
	}

	await migrateBridgeConfig(bridgeDir, io);

	// Classified before prompting and before the config write, so an unusable
	// set of instruction files costs the pilot nothing.
	const instructionWrites = planAgentInstructions(
		resolveInstructionTargets(bridgeDir, options.files),
		io,
	);

	const settings = loadSplitRcSettings(bridgeDir);

	if (!options.headless) {
		try {
			settings.workspace = await promptScalar(io, "workspace", settings.workspace);
			settings.backlog = await promptScalar(io, "backlog", settings.backlog);
			settings.kb = await promptScalar(io, "kb", settings.kb);
			settings.homeBranch = await promptScalar(io, "home-branch", settings.homeBranch);
			settings.workBranchPrefix = await promptScalar(
				io,
				"work-branch-prefix",
				settings.workBranchPrefix,
			);
		} finally {
			io.close();
		}
	}

	// At L1 `backlog:` names a kb memo, not a directory. A bridge migrated from
	// L0 already carries the memo its migration minted; a fresh one does not,
	// and without this update-backlog and dump-backlog have nothing to read.
	if (!uuidLike(settings.backlog)) {
		settings.backlog = mintBacklogMemo(bridgeDir, resolveFrom(bridgeDir, settings.kb), io);
	}

	const basePath = baseConfigPath(bridgeDir);
	writeFileAtomic(basePath, renderBaseConfig(settings, CURRENT_COMPATIBILITY_LEVEL));
	writeNosediveDirGitignore(bridgeDir);
	io.log(`Wrote ${formatPath(basePath)}`);

	for (const write of instructionWrites) {
		writeFileAtomic(write.path, write.content);
		io.log(`Wrote ${formatPath(write.path)}`);
	}
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(seed, args);
}
