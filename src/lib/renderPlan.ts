import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit } from "./repoWorkspaceCore.js";

import { GIT_LOCAL_ENV_KEYS } from "./constants.js";

export function quoteYamlString(value: string): string {
	return JSON.stringify(value);
}

export function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(
		dirname(path),
		`.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

export function cleanGitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of GIT_LOCAL_ENV_KEYS) delete env[key];
	return env;
}

export function gitOutput(cwd: string, args: string[]): string | undefined {
	const result = runGit(cwd, args);
	if (result.status !== 0) return undefined;
	return result.stdout.trim();
}

export function gitOk(cwd: string, args: string[]): boolean {
	return runGit(cwd, args).status === 0;
}

export function executableForSpawn(command: string): string {
	if (process.platform === "win32" && (command === "npm" || command === "npx")) {
		return `${command}.cmd`;
	}
	return command;
}
