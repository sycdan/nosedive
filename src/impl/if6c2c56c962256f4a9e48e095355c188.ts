import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs, parseAddRepoEffortScopeArgs } from "../lib/kbDocs.js";
import { appendRepoScopeToEffort, resolveActiveEffortDoc } from "../lib/repoEffortScopes.js";
import { resolveRepoDoc } from "../lib/repoWorkspaceCore.js";

function addRepoEffort(args: string[], io: CommandIo): void {
	const options = parseAddRepoEffortScopeArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("add-repo.effort requires a configured kb directory");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const repoDoc = resolveRepoDoc(kbDocs, options.repoRef);
	const effortDoc = resolveActiveEffortDoc(kbDocs, rc);
	const entry = appendRepoScopeToEffort(effortDoc.path, {
		id: repoDoc.id,
		ref: options.repoEntryRef,
		readOnly: options.readOnly,
	});

	io.log(`Added scope ${entry} to ${formatPath(effortDoc.path)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(addRepoEffort, args);
}
