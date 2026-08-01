import { existsSync } from "node:fs";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import {
	DehydrateRepoWorkspaceResult,
	ensureSafeTargetPath,
	maybeResolveRepoDoc,
	parseDehydrateRepoWorkspaceArgs,
} from "../lib/repoWorkspaceCore.js";
import {
	dehydrateHasUncommittedWork,
	dehydrateHasUnpublishedCommits,
	ensureDehydrateTargetOwnership,
	expectedWorktreePath,
	removeHydratedWorktree,
	resolveDehydrateTargetFromPath,
} from "../lib/repoWorktrees.js";

function dehydrateRepoWorkspace(args: string[], io: CommandIo): void {
	const options = parseDehydrateRepoWorkspaceArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	let repoDoc = maybeResolveRepoDoc(kbDocs, options.repoRef);
	let targetPath: string;

	if (repoDoc) {
		targetPath = expectedWorktreePath(repoDoc, rc.bridgeDir);
		ensureSafeTargetPath(repoDoc.id, targetPath, rc.workspaceDir);
	} else {
		const resolved = resolveDehydrateTargetFromPath(
			options.repoRef,
			kbDocs,
			rc.bridgeDir,
			rc.workspaceDir,
		);
		repoDoc = resolved.repoDoc;
		targetPath = resolved.targetPath;
	}

	const repoId = repoDoc.id;
	if (!existsSync(targetPath)) {
		const noopResult: DehydrateRepoWorkspaceResult = { status: "noop", repoId, targetPath };
		io.log(
			`${noopResult.status} repo=${noopResult.repoId} path=${formatPath(noopResult.targetPath)}`,
		);
		return;
	}

	ensureDehydrateTargetOwnership(repoId, targetPath);
	if (!options.force && dehydrateHasUncommittedWork(targetPath)) {
		throw new Error(
			`refusing to dehydrate repo ${repoId} at ${formatPath(targetPath)}: checkout has uncommitted work; rerun with --force`,
		);
	}
	if (!options.force && dehydrateHasUnpublishedCommits(targetPath)) {
		throw new Error(
			`refusing to dehydrate repo ${repoId} at ${formatPath(targetPath)}: checkout has unpublished commits; rerun with --force`,
		);
	}

	removeHydratedWorktree(repoId, targetPath, options.force);
	const result: DehydrateRepoWorkspaceResult = { status: "removed", repoId, targetPath };
	io.log(`${result.status} repo=${result.repoId} path=${formatPath(result.targetPath)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(dehydrateRepoWorkspace, args);
}
