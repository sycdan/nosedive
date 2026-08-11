import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import {
	appendDiveSection,
	bridgeBacklogMemoBody,
	diveDocs,
	diveTags,
	ListedDive,
	listedDive,
	localOnlyKbDocIds,
} from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import {
	CURRENT_COMPATIBILITY_LEVEL,
	PREFLIGHT_GUIDANCE,
	PREFLIGHT_NO_DIVE_LINE,
	prePushHook,
} from "../lib/constants.js";
import {
	formatPath,
	NosediveRc,
	readNosediveRc,
	resolveFrom,
	toPosixPath,
} from "../lib/coreParsing.js";
import {
	gitCommonDir,
	hookInvokesPrePush,
	pilotIdentityLines,
	printManualHookAdvice,
	readPilotIdentity,
} from "../lib/gitState.js";
import { KbDoc, loadKbDocs, readActiveDiveId } from "../lib/kbDocs.js";
import { bridgeCompatibilityLevel, nosediveInvocation } from "../lib/packageBacklog.js";
import { describeBridgeLevelDrift } from "../lib/packageLevels.js";
import { gitRun } from "../lib/repoWorkspaceCore.js";
import { resolveEffortDoc } from "../lib/repoEffortScopes.js";
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";

const STALE_BRIDGE_NOSE =
	"nose: fix this^ first, by rebasing the bridge onto FETCH_HEAD before trusting the backlog below";
const UNWIRED_HOOK_NOSE =
	"nose: fix this^ first, by wiring _pre-push.hook before pushing bridge changes";

interface PrePushHookCheck {
	wired: boolean;
}

function installHook(hookPath: string, io: CommandIo): void {
	mkdirSync(dirname(hookPath), { recursive: true });
	writeFileAtomic(hookPath, prePushHook(nosediveInvocation()));
	chmodSync(hookPath, 0o755);
	io.log(`Installed nosedive pre-push hook: ${formatPath(hookPath)}`);
}

/**
 * Installs or verifies the pre-push hook. An unwired foreign hook is a call to
 * attention, not a reason to hide the session-start report: the pilot still
 * needs the backlog to know what they were preparing to do.
 */
function ensurePrePushHook(rc: NosediveRc, io: CommandIo): PrePushHookCheck {
	const hooksPath = gitOutput(rc.bridgeDir, ["config", "--get", "core.hooksPath"]);
	if (hooksPath) {
		const hookPath = join(resolveFrom(rc.bridgeDir, hooksPath), "pre-push");
		const wired = existsSync(hookPath) && hookInvokesPrePush(readFileSync(hookPath, "utf8"));
		if (!wired) {
			printManualHookAdvice(
				`core.hooksPath is set to ${toPosixPath(hooksPath)}; nosedive will not change it or write an ignored .git/hooks/pre-push.`,
				io,
			);
			return { wired: false };
		}
		return { wired: true };
	}

	const commonDir = gitCommonDir(rc.bridgeDir);
	if (!commonDir) throw new Error("nosedive preflight must be run inside a git-backed bridge");
	const hookPath = join(commonDir, "hooks", "pre-push");
	if (!existsSync(hookPath)) {
		installHook(hookPath, io);
		return { wired: true };
	}

	const existing = readFileSync(hookPath, "utf8");
	if (existing.includes("nosedive-managed")) {
		installHook(hookPath, io);
		return { wired: true };
	}
	if (hookInvokesPrePush(existing)) {
		// Foreign hook already invokes _pre-push.hook under its own launcher -- leave it unchanged.
		return { wired: true };
	}
	printManualHookAdvice(
		`foreign pre-push hook exists at ${formatPath(hookPath)}; leaving it unchanged.`,
		io,
	);
	return { wired: false };
}

function preferredBridgeRemote(bridgeDir: string): string | undefined {
	const remotes = (gitOutput(bridgeDir, ["remote"])?.split(/\r?\n/).filter(Boolean) ?? []).filter(
		(remote) => gitOutput(bridgeDir, ["config", "--get", `remote.${remote}.url`]),
	);
	if (remotes.length === 0) return undefined;
	return remotes.includes("origin") ? "origin" : remotes[0];
}

function bridgeTrunkBranch(bridgeDir: string, remote: string): string {
	const remoteHead = gitRun(
		bridgeDir,
		["ls-remote", "--symref", remote, "HEAD"],
		`failed to resolve bridge trunk from remote ${remote}`,
	);
	const branch = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/m.exec(remoteHead)?.[1]?.trim();
	if (!branch) {
		throw new Error(
			`failed to resolve bridge trunk from remote ${remote}: remote HEAD does not name a branch`,
		);
	}
	return branch;
}

interface BridgeFreshness {
	remote?: string;
	branch?: string;
	head?: string;
	trunk?: string;
	ahead: number;
	behind: number;
}

function countCommits(bridgeDir: string, range: string): number {
	const count = Number.parseInt(
		gitRun(bridgeDir, ["rev-list", "--count", range], `failed to compare bridge ${range}`),
		10,
	);
	if (!Number.isFinite(count)) throw new Error(`failed to parse bridge commit count: ${range}`);
	return count;
}

function fetchBridgeTrunk(bridgeDir: string): BridgeFreshness {
	const remote = preferredBridgeRemote(bridgeDir);
	if (!remote) return { ahead: 0, behind: 0 };
	const branch = bridgeTrunkBranch(bridgeDir, remote);
	gitRun(
		bridgeDir,
		["fetch", "--prune", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
		`failed to fetch bridge trunk ${remote}/${branch} before preflight`,
	);
	return {
		remote,
		branch,
		head: gitRun(bridgeDir, ["rev-parse", "--short", "HEAD"], "failed to resolve bridge HEAD"),
		trunk: gitRun(
			bridgeDir,
			["rev-parse", "--short", "FETCH_HEAD"],
			"failed to resolve fetched bridge trunk",
		),
		ahead: countCommits(bridgeDir, "FETCH_HEAD..HEAD"),
		behind: countCommits(bridgeDir, "HEAD..FETCH_HEAD"),
	};
}

/**
 * Every kb doc, or undefined with the reason on stderr. Loaded once per run and
 * shared: both the current-dive lines and the dive list read the same set, and
 * the parse is the expensive part of either.
 */
function loadBridgeKbDocs(rc: NosediveRc, io: CommandIo): KbDoc[] | undefined {
	if (!rc.kbDir) return undefined;
	try {
		return loadKbDocs(rc.kbDir, rc.bridgeDir);
	} catch (err) {
		io.err(err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

/**
 * Prints `nosedive-current-dive-id`/`-gist`/`nosedive-current-effort`. No
 * active dive means no lines and no noise; a marker that fails to resolve
 * past that point prints whatever did resolve and puts the reason on stderr.
 */
function printCurrentDiveAndEffort(
	rc: NosediveRc,
	kbDocs: KbDoc[] | undefined,
	io: CommandIo,
): void {
	const activeDiveId = readActiveDiveId(rc.workspaceDir);
	if (!activeDiveId) return;
	io.log(`nosedive-current-dive-id: ${activeDiveId}`);

	if (!rc.kbDir) {
		io.err(`dive ${activeDiveId} is active but no kb directory is configured`);
		return;
	}
	if (!kbDocs) return;

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

/**
 * Every `kind: dive` in the kb, split by whether it can be picked up. The split
 * is `needs-diver` rather than owner: a dive recorded with `--free` carries no
 * `meta.diver`, so filing by owner would put every unclaimed dive under nobody.
 */
function printDives(rc: NosediveRc, kbDocs: KbDoc[] | undefined, io: CommandIo): void {
	io.log("== dives ==");
	if (!kbDocs || !rc.kbDir) {
		io.err("no kb directory is configured, so no dives can be listed");
		return;
	}

	const localOnly = localOnlyKbDocIds(rc.bridgeDir, rc.kbDir);
	const available: ListedDive[] = [];
	const held: ListedDive[] = [];
	for (const doc of diveDocs(kbDocs)) {
		const tags = diveTags(doc, localOnly);
		(tags.includes("needs-diver") ? available : held).push(listedDive(doc, undefined, tags));
	}

	if (available.length === 0 && held.length === 0) {
		io.log(PREFLIGHT_NO_DIVE_LINE);
		return;
	}
	appendDiveSectionTo(io, "Available", available);
	appendDiveSectionTo(io, "Held", held);
}

function appendDiveSectionTo(io: CommandIo, label: string, dives: ListedDive[]): void {
	const lines: string[] = [];
	appendDiveSection(lines, label, dives);
	for (const line of lines) io.log(line);
}

function bridgeFreshnessLine(freshness: BridgeFreshness): string | undefined {
	if (!freshness.remote || !freshness.branch) return undefined;
	const trunk = `${freshness.remote}/${freshness.branch}${freshness.trunk ? ` ${freshness.trunk}` : ""}`;
	const head = freshness.head ?? "unknown";
	if (freshness.behind > 0 && freshness.ahead > 0) {
		return `nosedive-bridge-freshness: HEAD ${head} has diverged from ${trunk} (${freshness.ahead} ahead, ${freshness.behind} behind)`;
	}
	if (freshness.behind > 0) {
		return `nosedive-bridge-freshness: HEAD ${head} is behind ${trunk} by ${freshness.behind} commits`;
	}
	if (freshness.ahead > 0) {
		return `nosedive-bridge-freshness: HEAD ${head} contains ${trunk} and is ahead by ${freshness.ahead} commits`;
	}
	return `nosedive-bridge-freshness: HEAD ${head} matches ${trunk}`;
}

function printSessionReport(
	rc: NosediveRc,
	levelLine: string,
	freshness: BridgeFreshness,
	hookCheck: PrePushHookCheck,
	io: CommandIo,
): void {
	if (!rc.workspaceDir) throw new Error("preflight requires a configured workspace directory");

	// Identity is checked before anything is printed, same all-or-nothing shape as `whoami`.
	const identity = readPilotIdentity(rc.bridgeDir);
	if (identity.missing.length > 0) {
		io.err(`missing git config: ${identity.missing.join(", ")}`);
		io.setExitCode(1);
		return;
	}

	const kbDocs = loadBridgeKbDocs(rc, io);

	io.log("== bridge status ==");
	io.log(`nosedive-workspace: ${toPosixPath(rc.workspaceDir)}`);
	io.log(levelLine);
	io.log(`nosedive-pre-push-hook: ${hookCheck.wired ? "wired" : "unwired"}`);
	if (!hookCheck.wired) io.log(UNWIRED_HOOK_NOSE);
	const freshnessLine = bridgeFreshnessLine(freshness);
	if (freshnessLine) io.log(freshnessLine);
	if (freshness.behind > 0) io.log(STALE_BRIDGE_NOSE);
	printCurrentDiveAndEffort(rc, kbDocs, io);
	io.log("");

	io.log("== pilot identification ==");
	io.writeOut(pilotIdentityLines(identity));
	io.log("");

	// Identity first, so a reader knows whose dives these are; dives before the
	// backlog, because what the pilot is in the middle of outranks what they
	// could start.
	printDives(rc, kbDocs, io);
	io.log("");

	io.log("== open work: current effort backlog ==");
	try {
		io.writeOut(bridgeBacklogMemoBody(rc));
	} catch (err) {
		io.err(err instanceof Error ? err.message : String(err));
	}
	io.log("");
	io.log(PREFLIGHT_GUIDANCE);
}

/**
 * Level drift is surfaced here and nowhere else: preflight runs once per
 * session, so this is the earliest point at which the pilot can be told, and
 * bailing at the first `jump` instead would cost them the work of choosing
 * what to work on first. A gap with a migration in it blocks -- every other
 * contracted command is refusing already, so preflight fails too; it just
 * fails better.
 */
function preflight(_args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	const hookCheck = ensurePrePushHook(rc, io);
	const freshness = fetchBridgeTrunk(rc.bridgeDir);
	const drift = describeBridgeLevelDrift(
		bridgeCompatibilityLevel(rc.bridgeDir) ?? CURRENT_COMPATIBILITY_LEVEL,
	);
	if (drift.blocking) {
		io.err(drift.detail ?? drift.line);
		io.setExitCode(1);
		return;
	}
	printSessionReport(rc, drift.line, freshness, hookCheck, io);
	if (!hookCheck.wired || freshness.behind > 0) io.setExitCode(1);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(preflight, args);
}
