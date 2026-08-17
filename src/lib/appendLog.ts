import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "./coreParsing.js";
import { appendTimestampedSection } from "./kbSections.js";
import { loadKbDocs, readActiveDiveId } from "./kbDocs.js";

export interface AppendLogOptions {
	label?: string;
	gist?: string;
}

function optionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseAppendLogArgs(args: string[]): AppendLogOptions {
	const options: AppendLogOptions = {};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		const flag = ["--label", "--gist"].find(
			(candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
		);
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown append-log.dive option: ${arg}`);
			// The body is never an argument. Saying so beats "unexpected argument",
			// because the mistake is about where the text goes, not that it is extra.
			throw new Error(
				`append-log.dive takes the section body on stdin, not as an argument: ${arg}`,
			);
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value.trim()) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		if (flag === "--label") options.label = value.trim();
		else options.gist = value.trim();
	}
	// Both are one line by nature. A newline in either means a shell handed over
	// something meant for the body, and under npx the rest of it is already gone.
	for (const [flag, value] of [
		["--label", options.label],
		["--gist", options.gist],
	] as const) {
		if (value?.includes("\n"))
			throw new Error(`${flag} must be a single line; pipe the body instead`);
	}
	return options;
}

/**
 * The whole body, read at once from fd 0.
 *
 * A terminal is refused rather than read. With no pipe there is nothing to
 * read and the command would wait forever, which looks like a hang and not
 * like a usage error -- the one way stdin can be worse than a flag, and the
 * cheapest to close.
 */
export function readStdinBody(): string {
	if (process.stdin.isTTY) {
		throw new Error(
			"append-log.dive reads the section body on stdin; pipe it, e.g. `git log --oneline -3 | nosedive append-log.dive`",
		);
	}
	// CRLF would otherwise survive into the document and litter every later diff.
	const body = readFileSync(0, "utf8").replaceAll("\r\n", "\n").trim();
	if (!body) throw new Error("append-log.dive refuses an empty section; nothing was piped in");
	return body;
}

export function appendLogToDive(args: string[], io: CommandIo, body: string): void {
	const options = parseAppendLogArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("append-log.dive requires a configured kb directory");
	if (!rc.workspaceDir)
		throw new Error("append-log.dive requires a configured workspace directory");

	const activeId = readActiveDiveId(rc.workspaceDir);
	if (!activeId) {
		throw new Error(
			`no active dive to log against: ${formatPath(join(rc.workspaceDir, ".nosedive-ref"))} names none; jump a dive first`,
		);
	}
	const dive = loadKbDocs(rc.kbDir, rc.bridgeDir).find((doc) => doc.id === activeId);
	if (!dive) throw new Error(`active dive marker names no kb document: ${activeId}`);
	// A closed dive is `kind: memo`, and `land` clears the marker when it closes
	// one -- so this is a marker left pointing at history rather than an ordinary
	// case, and quietly editing a landed record is worse than saying so.
	if (dive.kind !== "dive") {
		throw new Error(`active dive ${activeId} is not a kind: dive doc; it is kind: ${dive.kind}`);
	}

	appendTimestampedSection(
		dive.path,
		options.gist ? `${options.gist}\n\n${body}` : body,
		options.label,
	);
	io.log(`Logged to ${formatPath(dive.path)}`);
}
