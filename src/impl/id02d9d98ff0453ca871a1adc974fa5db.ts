import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { PRE_PUSH_WORKSPACE_COMMIT_ERROR_ID } from "../lib/constants.js";
import { readNosediveRc, toPosixPath } from "../lib/coreParsing.js";
import { runGit } from "../lib/repoWorkspaceCore.js";

function gitOutput(cwd: string, args: string[], label: string): string {
	const result = runGit(cwd, args);
	if (result.status === 0) return result.stdout.trim();
	const detail = result.stderr.trim() || result.stdout.trim() || "unknown git error";
	throw new Error(`${label}: ${detail}`);
}

function prePushHook(_args: string[], io: CommandIo, cwd: string): void {
	const rc = readNosediveRc(cwd);
	if (!rc.workspaceDir) throw new Error("bridge config is missing workspace");

	const repoRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"], "cannot locate repository");
	const workspacePath = relative(repoRoot, rc.workspaceDir);
	if (isAbsolute(workspacePath) || workspacePath === ".." || workspacePath.startsWith(`..\\`)) {
		return;
	}
	const pathspec = workspacePath === "" ? "." : toPosixPath(workspacePath);
	const updates = process.stdin.isTTY ? "" : readFileSync(0, "utf8");

	for (const line of updates.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const fields = line.trim().split(/\s+/);
		if (fields.length !== 4) throw new Error(`invalid pre-push ref update: ${line}`);
		const localSha = fields[1]!;
		const remoteSha = fields[3]!;
		if (/^0+$/.test(localSha)) continue;

		const range = /^0+$/.test(remoteSha) ? localSha : `${remoteSha}..${localSha}`;
		const touchingCommits = gitOutput(
			repoRoot,
			["rev-list", range, "--", pathspec],
			"cannot inspect pushed commits",
		);
		if (!touchingCommits) continue;

		throw new Error(PRE_PUSH_WORKSPACE_COMMIT_ERROR_ID);
	}
}

export function run(args: string[], runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => prePushHook(commandArgs, io, runtime.cwd), args);
}
