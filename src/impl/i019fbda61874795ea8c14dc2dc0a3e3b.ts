import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { PRE_PUSH_HOOK } from "../lib/constants.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { gitCommonDir, printManualHookAdvice } from "../lib/gitState.js";
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";

function preflight(_args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	const hooksPath = gitOutput(rc.bridgeDir, ["config", "--get", "core.hooksPath"]);
	if (hooksPath) {
		printManualHookAdvice(
			`core.hooksPath is set to ${hooksPath}; nosedive will not change it or write an ignored .git/hooks/pre-push.`,
			io,
		);
		return;
	}

	const commonDir = gitCommonDir(rc.bridgeDir);
	if (!commonDir) throw new Error("nosedive preflight must be run inside a git-backed bridge");
	const hookPath = join(commonDir, "hooks", "pre-push");
	if (existsSync(hookPath)) {
		const existing = readFileSync(hookPath, "utf8");
		if (!existing.includes("nosedive-managed")) {
			printManualHookAdvice(
				`foreign pre-push hook exists at ${formatPath(hookPath)}; leaving it unchanged.`,
				io,
			);
			return;
		}
	}

	mkdirSync(dirname(hookPath), { recursive: true });
	writeFileAtomic(hookPath, PRE_PUSH_HOOK);
	chmodSync(hookPath, 0o755);
	io.log(`Installed nosedive pre-push hook: ${formatPath(hookPath)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(preflight, args);
}
