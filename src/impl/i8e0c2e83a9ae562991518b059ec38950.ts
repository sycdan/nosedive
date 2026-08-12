import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { bridgeBacklogMemoBody } from "../lib/backlogDives.js";
import {
	appendDiveSection,
	collectPreflightDives,
	ListedDive,
	localOnlyKbDocIds,
} from "../lib/diveListing.js";
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
import { GIT_HOOK_NAMES, proxyHook } from "../lib/commitProvenance.js";
import {
	gitCommonDir,
	hookInvokesPrePush,
	pilotIdentityLines,
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

const MANAGED_HOOKS_DIRNAME = "nosedive-hooks";
/**
 * Where the pilot's hooks lived before nosedive claimed `core.hooksPath`. The
 * directory, not the pre-push path: a bridge can have no pre-push of its own
 * and still have other hooks that need proxying.
 */
const ORIGINAL_HOOKS_DIR_RECORD = "original-hooks-dir";

function readHook(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function isManagedHook(text: string): boolean {
	return text.includes("nosedive-managed");
}

function writeHook(hookPath: string, body: string): void {
	mkdirSync(dirname(hookPath), { recursive: true });
	writeFileAtomic(hookPath, body);
	chmodSync(hookPath, 0o755);
}

function installHook(hookPath: string, originalHookPath: string | undefined, io: CommandIo): void {
	writeHook(hookPath, prePushHook(nosediveInvocation(), originalHookPath));
	io.log(`Installed nosedive pre-push hook: ${formatPath(hookPath)}`);
}

/**
 * Claiming `core.hooksPath` moves every hook name at once, not just pre-push,
 * so the ones nosedive has no opinion about are re-exported from the directory
 * it now owns. Only hooks that exist when this runs are covered: a hook the
 * pilot adds later is picked up by the next preflight.
 */
function proxyPilotHooks(managedHooksDir: string, pilotHooksDir: string): void {
	if (resolve(pilotHooksDir) === resolve(managedHooksDir)) return;
	for (const hookName of GIT_HOOK_NAMES) {
		if (hookName === "pre-push") continue;
		const original = join(pilotHooksDir, hookName);
		if (!existsSync(original)) continue;
		const proxy = join(managedHooksDir, hookName);
		const body = proxyHook(toPosixPath(original));
		if (readHook(proxy) === body) continue;
		writeHook(proxy, body);
	}
}

/**
 * Removes a managed hook git can no longer reach. Exactly one hooks directory
 * is ever read, so a managed hook outside it never runs and nothing refreshes
 * it -- which is how one rotted to a command name that no longer exists while
 * preflight went on reporting the shadowing file as wired. Preflight writes it
 * back the moment it is the reachable one again.
 */
function dropShadowedManagedHook(
	defaultHooksDir: string,
	activeHooksDir: string,
	io: CommandIo,
): void {
	if (resolve(defaultHooksDir) === resolve(activeHooksDir)) return;
	const shadowed = join(defaultHooksDir, "pre-push");
	const text = readHook(shadowed);
	if (!text || !isManagedHook(text)) return;
	rmSync(shadowed);
	io.log(`Removed shadowed nosedive pre-push hook: ${formatPath(shadowed)}`);
}

/**
 * Reconciles the pre-push hook, wrapping whatever hook the bridge already had.
 *
 * A configured `core.hooksPath` used to be a reason to refuse, which left the
 * hook nosedive had written with no maintainer -- frozen at the version that
 * wrote it, unreachable, and invisible, because the check reported the *other*
 * file as wired. There is one path now and it always re-pins. Taking the hooks
 * path over is only safe because the managed hook runs the pilot's own pre-push
 * first and proxies every other hook name they have, so nothing they wrote
 * stops firing.
 */
function ensurePrePushHook(rc: NosediveRc, io: CommandIo): void {
	const commonDir = gitCommonDir(rc.bridgeDir);
	if (!commonDir) throw new Error("nosedive preflight must be run inside a git-backed bridge");
	const managedHooksDir = join(commonDir, MANAGED_HOOKS_DIRNAME);
	const defaultHooksDir = join(commonDir, "hooks");
	const recordPath = join(managedHooksDir, ORIGINAL_HOOKS_DIR_RECORD);

	const configuredRaw = gitOutput(rc.bridgeDir, ["config", "--get", "core.hooksPath"]);
	const configuredDir = configuredRaw ? resolveFrom(rc.bridgeDir, configuredRaw) : undefined;
	const managedConfigured = !!configuredDir && resolve(configuredDir) === resolve(managedHooksDir);

	// Once nosedive owns core.hooksPath the configured value is its own
	// directory, so where the pilot's hooks live comes off the record instead.
	const pilotHooksDir = managedConfigured
		? readHook(recordPath)?.trim() || defaultHooksDir
		: (configuredDir ?? defaultHooksDir);
	const pilotHookPath = join(pilotHooksDir, "pre-push");
	const pilotHookText = readHook(pilotHookPath);
	const pilotWroteIt = pilotHookText !== undefined && !isManagedHook(pilotHookText);

	// A pilot who already calls _pre-push.hook under their own launcher is
	// doing this job themselves; wrapping it would run the gate twice.
	if (pilotWroteIt && hookInvokesPrePush(pilotHookText)) {
		dropShadowedManagedHook(defaultHooksDir, pilotHooksDir, io);
		return;
	}

	// Nothing of the pilot's to preserve and nobody else holding the hooks
	// path: the default directory is the one git reads, so manage the hook
	// there rather than claiming a config that did not need claiming.
	if (!pilotWroteIt && !configuredDir) {
		installHook(join(defaultHooksDir, "pre-push"), undefined, io);
		return;
	}

	installHook(
		join(managedHooksDir, "pre-push"),
		pilotWroteIt ? toPosixPath(pilotHookPath) : undefined,
		io,
	);
	proxyPilotHooks(managedHooksDir, pilotHooksDir);
	writeFileAtomic(recordPath, `${toPosixPath(pilotHooksDir)}\n`);
	if (!managedConfigured) {
		gitRun(
			rc.bridgeDir,
			["config", "core.hooksPath", toPosixPath(managedHooksDir)],
			"failed to point core.hooksPath at the nosedive hooks directory",
		);
	}
	dropShadowedManagedHook(defaultHooksDir, managedHooksDir, io);
	return;
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

function printDives(rc: NosediveRc, kbDocs: KbDoc[] | undefined, io: CommandIo): void {
	io.log("== dives ==");
	if (!kbDocs || !rc.kbDir) {
		io.err("no kb directory is configured, so no dives can be listed");
		return;
	}

	const { available, held } = collectPreflightDives(
		rc,
		kbDocs,
		localOnlyKbDocIds(rc.bridgeDir, rc.kbDir),
	);

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
	io.log("nosedive-pre-push-hook: wired");
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
	ensurePrePushHook(rc, io);
	const freshness = fetchBridgeTrunk(rc.bridgeDir);
	const drift = describeBridgeLevelDrift(
		bridgeCompatibilityLevel(rc.bridgeDir) ?? CURRENT_COMPATIBILITY_LEVEL,
	);
	if (drift.blocking) {
		io.err(drift.detail ?? drift.line);
		io.setExitCode(1);
		return;
	}
	printSessionReport(rc, drift.line, freshness, io);
	if (freshness.behind > 0) io.setExitCode(1);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(preflight, args);
}
