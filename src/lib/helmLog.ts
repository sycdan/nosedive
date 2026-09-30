import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BRIDGE_STATE_DIRNAME } from "./constants.js";
import { readNosediveRc } from "./coreParsing.js";

/** How many days of helm's log are kept; older days are pruned when helm starts. */
const KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_NAME = /^helm-(\d{4}-\d{2}-\d{2})\.log$/;

function helmLogDir(cwd: string): string {
	return join(readNosediveRc(cwd).bridgeDir, BRIDGE_STATE_DIRNAME, "logs");
}

/** The day's log helm appends to in the bridge it serves, named by the UTC date of `when`. */
export function helmLogPath(cwd: string, when: Date): string {
	return join(helmLogDir(cwd), `helm-${when.toISOString().slice(0, 10)}.log`);
}

/**
 * Appends one command helm ran, and everything it printed, to the day's log,
 * filed under `dive` or as `no dive`. The folder ignores itself, so git never
 * picks a log up. Never throws.
 */
export function appendHelmLog(
	cwd: string,
	dive: string | undefined,
	args: string[],
	output: string,
): void {
	try {
		const now = new Date();
		const path = helmLogPath(cwd, now);
		const dir = helmLogDir(cwd);
		mkdirSync(dir, { recursive: true });
		const ignore = join(dir, ".gitignore");
		if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
		appendFileSync(
			path,
			`## ${now.toISOString()} [${dive ?? "no dive"}] nosedive ${args.join(" ")}\n\n${output.trimEnd()}\n\n`,
		);
	} catch {
		// The log is a convenience; a folder that cannot be written must not take helm down.
	}
}

/** Deletes helm's daily logs dated more than 14 days before `now` (UTC); anything else stays. Never throws. */
export function pruneHelmLogs(cwd: string, now: Date): void {
	try {
		const dir = helmLogDir(cwd);
		if (!existsSync(dir)) return;
		const today = Date.parse(now.toISOString().slice(0, 10));
		for (const name of readdirSync(dir)) {
			const date = LOG_NAME.exec(name)?.[1];
			if (!date) continue;
			const day = Date.parse(date);
			if (Number.isNaN(day) || today - day <= KEEP_DAYS * DAY_MS) continue;
			try {
				rmSync(join(dir, name), { force: true });
			} catch {
				// One stuck file must not keep the rest.
			}
		}
	} catch {
		// Pruning is housekeeping; helm starts regardless.
	}
}
