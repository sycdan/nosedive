import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import {
	HydrateRepoWorkspaceResult,
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	gitRun,
	parseHydrateRepoWorkspaceArgs,
	resolveRepoDoc,
} from "../lib/repoWorkspaceCore.js";
import {
	ensureDetachedAtCommit,
	ensureRepoMarkerExcluded,
	ensureReusableExistingTarget,
	expectedWorktreePath,
	isDirEmpty,
	pruneStaleWorktrees,
	reconcilePushReadOnly,
	resolveRefCommit,
	writeRepoMarker,
} from "../lib/repoWorktrees.js";

function hydrateRepoWorkspace(args: string[], io: CommandIo): void {
	const options = parseHydrateRepoWorkspaceArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const repoDoc = resolveRepoDoc(kbDocs, options.repoRef);
	const repoId = repoDoc.id;

	const sourcePath = ensureManagedRepoCache(repoDoc, rc.bridgeDir);
	const targetPath = expectedWorktreePath(repoDoc, rc.bridgeDir);
	ensureSafeTargetPath(repoId, targetPath, rc.workspaceDir);
	const ref = options.at ?? repoDoc.repoBaseBranch ?? "main";
	const commit = resolveRefCommit(sourcePath, repoId, ref);

	let status: HydrateRepoWorkspaceResult["status"] = "noop";
	let changed = false;
	const targetExists = existsSync(targetPath);

	if (targetExists && !statSync(targetPath).isDirectory()) {
		throw new Error(
			`unsafe target path for repo ${repoId}: target exists but is not a directory: ${formatPath(targetPath)}`,
		);
	}

	if (!targetExists || (statSync(targetPath).isDirectory() && isDirEmpty(targetPath))) {
		mkdirSync(dirname(targetPath), { recursive: true });
		pruneStaleWorktrees(sourcePath, repoId);
		gitRun(
			sourcePath,
			["worktree", "add", "--detach", targetPath, commit],
			`failed to create worktree for repo ${repoId} at ${formatPath(targetPath)}`,
		);
		if (writeRepoMarker(targetPath, repoId)) changed = true;
		if (ensureRepoMarkerExcluded(targetPath, repoId)) changed = true;
		status = "created";
	} else {
		ensureReusableExistingTarget(repoId, targetPath, sourcePath);
		if (ensureDetachedAtCommit(targetPath, commit, repoId)) changed = true;
		if (writeRepoMarker(targetPath, repoId)) changed = true;
		if (ensureRepoMarkerExcluded(targetPath, repoId)) changed = true;
	}

	if (reconcilePushReadOnly(sourcePath, targetPath, options.readOnly, repoId)) changed = true;
	if (status !== "created") status = changed ? "updated" : "noop";

	const result: HydrateRepoWorkspaceResult = {
		status,
		repoId,
		targetPath,
		commit,
	};
	io.log(
		`${result.status} repo=${result.repoId} path=${formatPath(result.targetPath)} commit=${result.commit}`,
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(hydrateRepoWorkspace, args);
}
