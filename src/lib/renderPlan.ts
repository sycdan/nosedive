import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit } from "./gitProcess.js";

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

export function gitOk(cwd: string, args: string[]): boolean {
	return runGit(cwd, args).status === 0;
}

export function executableForSpawn(command: string): string {
	if (process.platform === "win32" && (command === "npm" || command === "npx")) {
		return `${command}.cmd`;
	}
	return command;
}
