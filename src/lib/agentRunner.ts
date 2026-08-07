import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

import { formatPath, type NosediveRc } from "./coreParsing.js";

/** The prompt reaches the runner on stdin, so this token contributes no argv word. */
export const STDIN_PLACEHOLDER = "<nosedive-stdout-piped-to-stdin>";
/** Replaced by the `agent-tier-<n>` model for the effort being attempted. */
export const MODEL_PLACEHOLDER = "<nosedive-effort-model>";

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

/**
 * The usage string is a grammar, not a suggestion: it is split on whitespace
 * into literal argv words with two known placeholders substituted, and spawned
 * without a shell. An agent cannot be trusted to assemble a command line, so
 * nothing here interpolates, quotes or evaluates -- an unknown `<placeholder>`
 * is an error rather than a literal argument.
 */
export function parseColdStartUsage(usage: string, model: string): ColdStartCommand {
	const tokens = usage.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) throw new Error("agent runner meta.cold-start-usage is empty");

	const stdinCount = tokens.filter((token) => token === STDIN_PLACEHOLDER).length;
	const modelCount = tokens.filter((token) => token === MODEL_PLACEHOLDER).length;
	if (stdinCount !== 1) {
		throw new Error(
			`agent runner meta.cold-start-usage must use ${STDIN_PLACEHOLDER} exactly once`,
		);
	}
	if (modelCount !== 1) {
		throw new Error(
			`agent runner meta.cold-start-usage must use ${MODEL_PLACEHOLDER} exactly once`,
		);
	}

	const words: string[] = [];
	for (const token of tokens) {
		if (token === STDIN_PLACEHOLDER) continue;
		if (token === MODEL_PLACEHOLDER) {
			words.push(model);
			continue;
		}
		if (token.startsWith("<") && token.endsWith(">")) {
			throw new Error(`agent runner meta.cold-start-usage has an unknown placeholder: ${token}`);
		}
		words.push(token);
	}

	const executable = words[0];
	if (executable === undefined || executable === model) {
		throw new Error("agent runner meta.cold-start-usage must start with the runner executable");
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
