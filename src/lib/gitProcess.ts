import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { GIT_LOCAL_ENV_KEYS } from "./constants.js";

export interface GitCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export const GIT_SAFE_BARE_CONFIG_ARGS = ["-c", "safe.bareRepository=all"] as const;

export function cleanGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of GIT_LOCAL_ENV_KEYS) delete env[key];
	return env;
}

export function runGit(cwd: string, args: string[]): GitCommandResult {
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

export function gitOutput(cwd: string, args: string[]): string | undefined {
	const result = runGit(cwd, args);
	if (result.status !== 0) return undefined;
	return result.stdout.trim();
}
