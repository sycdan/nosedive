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
	// Windows can briefly hold temp-file handles while scanners or indexers run.
	// A transient rename failure here usually succeeds on the next try.
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			renameSync(tmp, path);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const shouldRetry = code === "EPERM" || code === "EACCES" || code === "EBUSY";
			if (!shouldRetry || attempt === 4) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** attempt);
		}
	}
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
