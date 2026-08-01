import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs, parseAddRepoArgs } from "../lib/kbDocs.js";
import { applyWrite } from "../lib/nukeApply.js";
import {
	appendRepoToEffort,
	resolveAddRepoEffort,
	resolveRepoDoc,
} from "../lib/repoWorkspaceCore.js";

function addRepo(args: string[], io: CommandIo): void {
	const options = parseAddRepoArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const repoDoc = resolveRepoDoc(kbDocs, options.repoRef);
	const effort = resolveAddRepoEffort(rc, options);
	appendRepoToEffort(effort.path, {
		id: repoDoc.id,
		ref: options.repoEntryRef,
		readOnly: options.readOnly,
	});

	io.log(`Added ${repoDoc.id} to ${formatPath(effort.path)}`);

	if (options.apply && effort.active && rc.workspaceDir) {
		applyWrite(io);
	} else if (options.apply && !effort.active) {
		io.log("Generated docs not updated because the target effort is not active.");
	}
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(addRepo, args);
}
