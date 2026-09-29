import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { readNosediveRc } from "./coreParsing.js";
import { readActiveDiveId } from "./kbDocs.js";

/** The active dive's scratch folder, where helm keeps its log; none with no dive. */
export function diveLogDir(cwd: string): string | undefined {
	const rc = readNosediveRc(cwd);
	const id = readActiveDiveId(rc.workspaceDir);
	return id && rc.workspaceDir ? join(rc.workspaceDir, ".scratch", id) : undefined;
}

/**
 * Appends one command helm ran, and everything it printed, to `helm.log` in
 * the dive's scratch folder -- local only, like the rest of scratch. `dir` is
 * read before the command runs where the dive may end with it (land, bail).
 */
export function appendDiveLog(dir: string | undefined, args: string[], output: string): void {
	if (!dir) return;
	try {
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "helm.log"),
			`## ${new Date().toISOString()} nosedive ${args.join(" ")}\n\n${output.trimEnd()}\n\n`,
		);
	} catch {
		// The log is a convenience; a scratch folder that cannot be written must not take helm down.
	}
}
