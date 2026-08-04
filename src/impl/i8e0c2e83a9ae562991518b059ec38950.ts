import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { bridgeBacklogMemoBody } from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { PRE_PUSH_HOOK } from "../lib/constants.js";
import { formatPath, NosediveRc, readNosediveRc, resolveFrom, toPosixPath } from "../lib/coreParsing.js";
import {
	gitCommonDir,
	hookInvokesPrePush,
	pilotIdentityLines,
	printManualHookAdvice,
	readPilotIdentity,
} from "../lib/gitState.js";
import { KbDoc, loadKbDocs, readActiveDiveId } from "../lib/kbDocs.js";
import { resolveEffortDoc } from "../lib/repoEffortScopes.js";
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";

function installHook(hookPath: string, io: CommandIo): void {
	mkdirSync(dirname(hookPath), { recursive: true });
	writeFileAtomic(hookPath, PRE_PUSH_HOOK);
	chmodSync(hookPath, 0o755);
	io.log(`Installed nosedive pre-push hook: ${formatPath(hookPath)}`);
}

/**
 * Installs or verifies the pre-push hook. Returns `false` (and has already
 * printed advice + set exit 1) when no wiring to `_pre-push.hook` can be
 * found, whether that's a foreign hook or a `core.hooksPath` hook; the report
 * below is not worth printing until that's fixed.
 */
function ensurePrePushHook(rc: NosediveRc, io: CommandIo): boolean {
	const hooksPath = gitOutput(rc.bridgeDir, ["config", "--get", "core.hooksPath"]);
	if (hooksPath) {
		const hookPath = join(resolveFrom(rc.bridgeDir, hooksPath), "pre-push");
		const wired = existsSync(hookPath) && hookInvokesPrePush(readFileSync(hookPath, "utf8"));
		if (!wired) {
			printManualHookAdvice(
				`core.hooksPath is set to ${hooksPath}; nosedive will not change it or write an ignored .git/hooks/pre-push.`,
				io,
			);
			io.setExitCode(1);
			return false;
		}
		return true;
	}

	const commonDir = gitCommonDir(rc.bridgeDir);
	if (!commonDir) throw new Error("nosedive preflight must be run inside a git-backed bridge");
	const hookPath = join(commonDir, "hooks", "pre-push");
	if (!existsSync(hookPath)) {
		installHook(hookPath, io);
		return true;
	}

	const existing = readFileSync(hookPath, "utf8");
	if (existing.includes("nosedive-managed")) {
		installHook(hookPath, io);
		return true;
	}
	if (hookInvokesPrePush(existing)) {
		// Foreign hook already invokes _pre-push.hook under its own launcher -- leave it unchanged.
		return true;
	}
	printManualHookAdvice(
		`foreign pre-push hook exists at ${formatPath(hookPath)}; leaving it unchanged.`,
		io,
	);
	io.setExitCode(1);
	return false;
}

/**
 * Prints `nosedive-current-dive-id`/`-gist`/`nosedive-current-effort`. No
 * active dive means no lines and no noise; a marker that fails to resolve
 * past that point prints whatever did resolve and puts the reason on stderr.
 */
function printCurrentDiveAndEffort(rc: NosediveRc, io: CommandIo): void {
	const activeDiveId = readActiveDiveId(rc.workspaceDir);
	if (!activeDiveId) return;
	io.log(`nosedive-current-dive-id: ${activeDiveId}`);

	if (!rc.kbDir) {
		io.err(`dive ${activeDiveId} is active but no kb directory is configured`);
		return;
	}

	let kbDocs: KbDoc[];
	try {
		kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	} catch (err) {
		io.err(err instanceof Error ? err.message : String(err));
		return;
	}

	const activeDive = kbDocs.find((doc) => doc.kind === "dive" && doc.id === activeDiveId);
	if (!activeDive) {
		io.err(`active dive ${activeDiveId} is missing from kb`);
		return;
	}
	io.log(`nosedive-current-dive-gist: ${activeDive.gist}`);

	if (!activeDive.effortRef) return;
	try {
		const effort = resolveEffortDoc(kbDocs, rc, activeDive.effortRef);
		io.log(`nosedive-current-effort: ${effort.id}`);
	} catch (err) {
		io.err(err instanceof Error ? err.message : String(err));
	}
}

function printSessionReport(rc: NosediveRc, io: CommandIo): void {
	if (!rc.workspaceDir) throw new Error("preflight requires a configured workspace directory");

	// Identity is checked before anything is printed, same all-or-nothing shape as `whoami`.
	const identity = readPilotIdentity(rc.bridgeDir);
	if (identity.missing.length > 0) {
		io.err(`missing git config: ${identity.missing.join(", ")}`);
		io.setExitCode(1);
		return;
	}

	io.log("== bridge status ==");
	io.log(`nosedive-workspace: ${toPosixPath(rc.workspaceDir)}`);
	printCurrentDiveAndEffort(rc, io);
	io.log("");

	io.log("== pilot identification ==");
	io.writeOut(pilotIdentityLines(identity));
	io.log("");

	io.log("== open work: current effort backlog ==");
	try {
		io.writeOut(bridgeBacklogMemoBody(rc));
	} catch (err) {
		io.err(err instanceof Error ? err.message : String(err));
	}
}

function preflight(_args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	if (!ensurePrePushHook(rc, io)) return;
	printSessionReport(rc, io);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(preflight, args);
}
