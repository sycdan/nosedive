import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME } from "./constants.js";
import { readNosediveRc } from "./coreParsing.js";
import { helmLogPath, readLogSince, readLogTail, type LogCursor } from "./helmLog.js";

/** How often helm polls the bridge while a page listens, in ms. */
export const HELM_POLL_MS = 2000;

/** What the Internals view shows: the bridge config, today's log tail and the poll's timing. */
export interface HelmInternals {
	configPath: string;
	config: string;
	logPath: string;
	log: string;
	pollEvery: number;
	lastChangeAt: number | null;
}

/** Reads the bridge's config and today's log for the Internals view. */
export function helmInternals(cwd: string, lastChangeAt: number | null): HelmInternals {
	const configPath = join(
		readNosediveRc(cwd).bridgeDir,
		BRIDGE_STATE_DIRNAME,
		BASE_CONFIG_FILENAME,
	);
	let config = "";
	try {
		config = readFileSync(configPath, "utf8");
	} catch {
		// A bridge without a config shows an empty one.
	}
	const logPath = helmLogPath(cwd, new Date());
	return {
		configPath,
		config,
		logPath,
		log: readLogTail(logPath),
		pollEvery: HELM_POLL_MS,
		lastChangeAt,
	};
}

/**
 * Follows today's log from where helm started: `next` returns the text
 * appended since the last call, as an SSE `log` event, or "" when there is none.
 * Never throws.
 */
export function helmLogFollower(cwd: string): () => string {
	let cursor: LogCursor = { path: "", size: 0 };
	try {
		const path = helmLogPath(cwd, new Date());
		cursor = readLogSince({ path, size: 0 }, path).cursor;
	} catch {
		// Starts from nothing; the first tick picks the day up.
	}
	return () => {
		try {
			const read = readLogSince(cursor, helmLogPath(cwd, new Date()));
			cursor = read.cursor;
			return read.text ? `event: log\ndata: ${JSON.stringify(read.text)}\n\n` : "";
		} catch {
			return "";
		}
	};
}
