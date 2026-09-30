import { readNosediveRc } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { readActiveDiveId } from "./kbDocs.js";

/** What an open helm page follows: the active dive and the bridge's HEAD commit. */
export function helmState(cwd: string): { dive: string | null; head: string | null } {
	const rc = readNosediveRc(cwd);
	return {
		dive: readActiveDiveId(rc.workspaceDir) ?? null,
		head: gitOutput(cwd, ["rev-parse", "HEAD"]) ?? null,
	};
}
