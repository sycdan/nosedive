import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs, parseAddRepoFeatScopeArgs } from "../lib/kbDocs.js";
import { appendRepoScopeToFeat, resolveActiveFeatDoc } from "../lib/repoFeatScopes.js";
import { resolveRepoDoc } from "../lib/repoWorkspaceCore.js";

function addRepoFeat(args: string[], io: CommandIo): void {
	const options = parseAddRepoFeatScopeArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("add-repo.feat requires a configured kb directory");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const repoDoc = resolveRepoDoc(kbDocs, options.repoRef);
	const featDoc = resolveActiveFeatDoc(kbDocs, rc);
	const entry = appendRepoScopeToFeat(featDoc.path, {
		id: repoDoc.id,
		ref: options.repoEntryRef,
		workBranch: options.workBranch,
	});

	io.log(`Added scope ${entry} to ${formatPath(featDoc.path)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(addRepoFeat, args);
}
