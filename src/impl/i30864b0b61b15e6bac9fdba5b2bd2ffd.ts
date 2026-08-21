import { existsSync, unlinkSync } from "node:fs";

import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { type CommandIo } from "../lib/commands.js";
import { formatPath } from "../lib/coreParsing.js";
import { parseRecordRepoArgs, planRecordRepo } from "../lib/recordRepo.js";
import { writeFileAtomic } from "../lib/renderPlan.js";

function recordRepo(args: string[], io: CommandIo): void {
	const plan = planRecordRepo(parseRecordRepoArgs(args));
	writeFileAtomic(plan.repoPath, plan.repoContent);
	try {
		writeFileAtomic(plan.backlogPath, plan.backlogContent);
	} catch (error) {
		if (existsSync(plan.repoPath)) unlinkSync(plan.repoPath);
		throw error;
	}
	io.log(`Recorded ${formatPath(plan.repoPath)}`);
	io.log(`Added ${plan.name} to backlog scopes in ${formatPath(plan.backlogPath)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(recordRepo, args);
}
