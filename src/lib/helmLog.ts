import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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

/** Most of a log helm sends at once: the tail of anything longer. */
export const LOG_TAIL_BYTES = 64 * 1024;

/** Where a reader of the day's log has got to. */
export interface LogCursor {
	path: string;
	size: number;
}

function readRange(path: string, start: number, end: number): string {
	const from = Math.max(start, end - LOG_TAIL_BYTES);
	const buffer = Buffer.alloc(end - from);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buffer, 0, buffer.length, from);
	} finally {
		closeSync(fd);
	}
	return buffer.toString("utf8");
}

/**
 * The text appended to `path` since `cursor`, capped to its last 64 KB, and
 * the cursor moved past it; a new path starts from 0. A missing file, or one
 * that has not grown, gives "". Never throws.
 */
export function readLogSince(cursor: LogCursor, path: string): { text: string; cursor: LogCursor } {
	const start = cursor.path === path ? cursor.size : 0;
	try {
		const size = statSync(path).size;
		// A file that shrank was replaced; read it from the start.
		const from = size < start ? 0 : start;
		if (size === from) return { text: "", cursor: { path, size } };
		return { text: readRange(path, from, size), cursor: { path, size } };
	} catch {
		return { text: "", cursor: { path, size: start } };
	}
}

/** The last 64 KB of the log at `path`, or "" when there is none. Never throws. */
export function readLogTail(path: string): string {
	return readLogSince({ path, size: 0 }, path).text;
}
