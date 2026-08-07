import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

import { formatPath, type NosediveRc } from "./coreParsing.js";

/** The prompt nosedive built. It sits left of the pipe, where a reader expects the source of stdin. */
export const STDOUT_PLACEHOLDER = "<nosedive-command-stdout>";
/** Replaced by the `agent-tier-<n>` model for the effort being attempted. */
export const MODEL_PLACEHOLDER = "<nosedive-effort-model>";
/**
 * The one pipe is structural, not shell. Everything else a shell would act on
 * is refused, so a usage string that looks like a command line cannot quietly
 * become one.
 */
const SHELL_METACHARACTERS = /[&;<>$`"'()]/;
/** Placeholders wear the same angle brackets a shell redirects with, so they are set aside first. */
const PLACEHOLDER_SHAPED = /<[^<>\s]*>/g;

export interface ColdStartCommand {
	executable: string;
	args: string[];
}

export interface AgentAttempt {
	effort: number;
	model: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}

const USAGE_TEMPLATE = `${STDOUT_PLACEHOLDER} | <runner> [args] ${MODEL_PLACEHOLDER} [args]`;

function usageError(problem: string): Error {
	return new Error(`agent runner meta.cold-start-usage ${problem}; expected: ${USAGE_TEMPLATE}`);
}

/**
 * The usage string reads as a pipeline because that is what it describes -- but
 * it is a template with one fixed shape, not a shell command. The single pipe
 * separates the prompt from the runner; everything a shell would act on beyond
 * that is refused, and the right side becomes literal argv words spawned
 * without a shell. An agent that could assemble a command line could run
 * anything, so nothing here interpolates, quotes or evaluates.
 */
export function parseColdStartUsage(usage: string, model: string): ColdStartCommand {
	const trimmed = usage.trim();
	if (!trimmed) throw usageError("is empty");
	if (SHELL_METACHARACTERS.test(trimmed.replace(PLACEHOLDER_SHAPED, ""))) {
		throw usageError("is a template, not a shell command, so it cannot use shell operators");
	}

	const sides = trimmed.split("|");
	if (sides.length !== 2) throw usageError("must have exactly one pipe");
	const [source, runner] = sides as [string, string];
	if (source.trim() !== STDOUT_PLACEHOLDER) {
		throw usageError(`must pipe ${STDOUT_PLACEHOLDER} into the runner`);
	}

	const tokens = runner.trim().split(/\s+/).filter(Boolean);
	if (tokens.filter((token) => token === MODEL_PLACEHOLDER).length !== 1) {
		throw usageError(`must use ${MODEL_PLACEHOLDER} exactly once`);
	}

	const words: string[] = [];
	for (const token of tokens) {
		if (token === MODEL_PLACEHOLDER) {
			words.push(model);
			continue;
		}
		if (token.startsWith("<") && token.endsWith(">")) {
			throw usageError(`has an unknown placeholder: ${token}`);
		}
		words.push(token);
	}

	const executable = words[0];
	if (executable === undefined || executable === model) {
		throw usageError("must name the runner executable right of the pipe");
	}
	return { executable, args: words.slice(1) };
}

/** Every effort between minimum and maximum must name a model before the first call. */
export function resolveEffortLadder(rc: NosediveRc, minimum: number, maximum: number): string[] {
	const models: string[] = [];
	const missing: string[] = [];
	for (let effort = minimum; effort <= maximum; effort += 1) {
		const model = rc.agentTiers[effort];
		if (model) models.push(model);
		else missing.push(`agent-tier-${effort}`);
	}
	if (missing.length > 0) {
		throw new Error(`${formatPath(rc.path)} is missing ${missing.join(", ")}`);
	}
	return models;
}

/** Real program images, which spawn directly; anything else on Windows is an interpreted shim. */
const WINDOWS_IMAGE_EXTENSIONS = [".exe", ".com"];
const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat"];
const WINDOWS_SHIM = /\.(cmd|bat)$/i;
/** No whitespace and no shell metacharacters, so a shim's command line cannot be steered. */
const SAFE_SHIM_WORD = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

function firstExistingFile(candidates: string[]): string | undefined {
	return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

function withWindowsExtensions(base: string): string[] {
	if (process.platform !== "win32") return [base];
	if (extname(base)) return [base];
	return [...WINDOWS_IMAGE_EXTENSIONS, ...WINDOWS_SHIM_EXTENSIONS].map((ext) => `${base}${ext}`);
}

/**
 * Windows resolves an extensionless name through PATHEXT, which only a shell
 * does -- and node refuses to spawn a `.cmd` without one. So the lookup happens
 * here instead, preferring a real `.exe` over the npm shim that wraps it, and
 * the spawn stays shell-free wherever a real image exists.
 */
export function resolveExecutable(name: string): string {
	if (name.includes("/") || name.includes("\\")) {
		const resolved = firstExistingFile(withWindowsExtensions(name));
		if (!resolved) throw new Error(`agent runner executable not found: ${name}`);
		return resolved;
	}

	const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of pathDirs) {
		const resolved = firstExistingFile(withWindowsExtensions(join(dir, name)));
		if (resolved) return resolved;
	}
	throw new Error(`agent runner executable not found on PATH: ${name}`);
}

export function coldStart(command: ColdStartCommand, prompt: string, cwd: string): AgentAttempt {
	const executable = resolveExecutable(command.executable);
	// A shim is a batch file, so it can only be run through cmd. Every word is
	// checked against a strict charset first: the point of the grammar is that
	// no part of this command line is negotiable, and a shell would otherwise
	// reopen exactly that door.
	const throughShim = process.platform === "win32" && WINDOWS_SHIM.test(executable);
	if (throughShim) {
		for (const word of command.args) {
			if (!SAFE_SHIM_WORD.test(word)) {
				throw new Error(`agent runner argument is not safe to pass through a shim: ${word}`);
			}
		}
	}

	// Node deprecates passing an args array alongside `shell`, because it
	// concatenates without escaping. The words are already known to need no
	// escaping, so the concatenation happens here, explicitly, and the args
	// array stays empty.
	const result = throughShim
		? spawnSync([`"${executable}"`, ...command.args].join(" "), {
				cwd,
				input: prompt,
				encoding: "utf8",
				shell: true,
				maxBuffer: 64 * 1024 * 1024,
			})
		: spawnSync(executable, command.args, {
				cwd,
				input: prompt,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			});
	if (result.error) {
		throw new Error(`agent runner ${command.executable} failed to start: ${result.error.message}`);
	}
	return {
		effort: -1,
		model: "",
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitCode: result.status ?? 1,
	};
}

function fenced(label: string, text: string): string[] {
	const body = text.trim();
	return [`### ${label}`, "", "```text", body || "(empty)", "```"];
}

/**
 * A failed attempt is appended to the prompt rather than replacing it, so the
 * next tier reads the original instructions plus every way the cheaper models
 * have already failed them. The shape is fixed so the escalation is legible to
 * a model that has never seen the earlier ones.
 */
export function appendFailedAttempt(prompt: string, attempt: AgentAttempt): string {
	return [
		prompt.trimEnd(),
		"",
		`## Failed attempt at effort ${attempt.effort}`,
		"",
		`model: ${attempt.model}`,
		`exit code: ${attempt.exitCode}`,
		"",
		...fenced("stdout", attempt.stdout),
		"",
		...fenced("stderr", attempt.stderr),
		"",
	].join("\n");
}
