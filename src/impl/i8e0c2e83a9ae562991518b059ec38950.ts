import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { appendJumpableDives, formatJumpableDive, localOnlyKbDocIds } from "../lib/diveListing.js";
import { collectPreflightDives } from "../lib/diveSelection.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import {
	CURRENT_COMPATIBILITY_LEVEL,
	KNOWN_INSTRUCTION_FILES,
	MANAGED_INSTRUCTIONS_BEGIN,
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
import { bridgeTrunkBranch, preferredBridgeRemote } from "../lib/bridgeTrunk.js";
import { readAgentGuidance } from "../lib/commandGuidance.js";
import { GIT_HOOK_NAMES, proxyHook } from "../lib/commitProvenance.js";
import {
	gitCommonDir,
	hookInvokesPrePush,
	pilotIdentityLines,
	readPilotIdentity,
} from "../lib/gitState.js";
import { KbDoc, loadKbDocs, readActiveDiveId, readKbDocById } from "../lib/kbDocs.js";
import {
	bridgeCompatibilityLevel,
	describeInstructionDrift,
	isPackageCheckout,
	nosediveInvocation,
	nosedivePackageVersion,
	renderedSurfaceDigest,
	SURFACE_STAMP_PATTERN,
} from "../lib/packageBacklog.js";
import { describeBridgeLevelDrift } from "../lib/packageLevels.js";
import { gitRun } from "../lib/repoWorkspaceCore.js";
import { resolveFeatDoc } from "../lib/repoFeatScopes.js";
import { gitOutput } from "../lib/gitProcess.js";
import { writeFileAtomic } from "../lib/renderPlan.js";

const STALE_BRIDGE_NOSE =
	"nose: fix this^ first, by rebasing the bridge onto FETCH_HEAD before trusting the dives below";
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

function installHook(hookPath: string, originalHookPath: string | undefined): void {
	writeHook(hookPath, prePushHook(nosediveInvocation(), originalHookPath));
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
 * file as wired.
 *
 * Nosedive owns one hooks directory now and always re-pins what is in it, so
 * there is no second location to fall out of date. Taking `core.hooksPath` over
 * is only safe because the managed hook runs the bridge's own pre-push first
 * and proxies every other hook name beside it, so nothing the pilot wrote stops
 * firing.
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

	const managedHookPath = join(managedHooksDir, "pre-push");
	installHook(managedHookPath, pilotWroteIt ? toPosixPath(pilotHookPath) : undefined);
	proxyPilotHooks(managedHooksDir, pilotHooksDir);
	writeFileAtomic(recordPath, `${toPosixPath(pilotHooksDir)}\n`);
	// Re-pinning an already-claimed hooks path is housekeeping every run does;
	// saying so every session would train the pilot to skim past the line. Only
	// the takeover -- which moves where git looks for every hook -- is news.
	if (!managedConfigured) {
		gitRun(
			rc.bridgeDir,
			["config", "core.hooksPath", toPosixPath(managedHooksDir)],
			"failed to point core.hooksPath at the nosedive hooks directory",
		);
		io.log(`Installed nosedive pre-push hook: ${formatPath(managedHookPath)}`);
	}
	dropShadowedManagedHook(defaultHooksDir, managedHooksDir, io);
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
	if (!branch) {
		return {
			remote,
			branch: undefined,
			ahead: 0,
			behind: 0,
		};
	}
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
 * Prints `nosedive-current-dive-id`/`-gist`/`nosedive-current-feat`. No
 * active dive means no lines and no noise; a marker that fails to resolve
 * past that point prints whatever did resolve and puts the reason on stderr.
 */
function printCurrentDiveAndFeat(rc: NosediveRc, kbDocs: KbDoc[] | undefined, io: CommandIo): void {
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

	if (!activeDive.featRef) return;
	try {
		const feat = resolveFeatDoc(kbDocs, rc, activeDive.featRef);
		io.log(`nosedive-current-feat: ${feat.id}`);
	} catch (err) {
		io.err(err instanceof Error ? err.message : String(err));
	}
}

/**
 * Where to look when nothing listed above fits. The memo itself stays
 * unrendered -- it grows with the backlog and most sessions never need it --
 * but naming nothing left an agent whose session opened with no dive to pick
 * up with no way to reach the feats and repos except by grepping kb/.
 */
function backlogPointerLine(rc: NosediveRc): string | undefined {
	if (!rc.backlog || !rc.kbDir) return undefined;
	const backlog = readKbDocById(rc.kbDir, rc.bridgeDir, rc.backlog);
	if (!backlog) return undefined;
	return `${backlog.relPath} lists every feat and repo -- read it when planning new work, not by default: it is long, and grows with the backlog.`;
}

function printDives(rc: NosediveRc, kbDocs: KbDoc[] | undefined, io: CommandIo): void {
	io.log("== feats and their dives ==");
	if (!kbDocs || !rc.kbDir) {
		io.err("no kb directory is configured, so no feats or dives can be listed");
		return;
	}
	const backlogPointer = backlogPointerLine(rc);

	const { available, held, warnings } = collectPreflightDives(
		rc,
		kbDocs,
		localOnlyKbDocIds(rc.bridgeDir, rc.kbDir),
	);
	for (const warning of warnings) io.err(warning);

	if (available.length === 0 && held.length === 0) {
		io.log(PREFLIGHT_NO_DIVE_LINE);
		if (backlogPointer) io.log(backlogPointer);
		return;
	}

	const lines: string[] = [""];
	appendJumpableDives(lines, available, true);
	// Held dives are not grouped under their feats: they are not on offer, so
	// the only thing worth reading off them is who to ask, and a feat heading
	// over work nobody here can take reads as a choice that is not there.
	if (held.length > 0) {
		lines.push("", "Held by other pilots:", "");
		for (const dive of held) lines.push(formatJumpableDive(dive, true));
	}
	if (backlogPointer) lines.push("", backlogPointer);
	for (const line of lines) io.log(line);
}

function bridgeFreshnessLine(freshness: BridgeFreshness, trunkBranch: string): string | undefined {
	if (!freshness.remote) return undefined;
	if (!freshness.branch) {
		return `nosedive-bridge-freshness: remote ${freshness.remote} exists but has no published branch yet; run git push -u ${freshness.remote} ${trunkBranch}`;
	}
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

/**
 * Whether each managed instruction file describes the commands this install
 * actually has. Preflight is where this belongs and nowhere else: the file is
 * checked in and shared, so the pilot who has to act on it is not the one who
 * wrote it, and they find out at session start rather than when their agent
 * invokes a command that does not exist.
 *
 * It reports and never rewrites. `seed` owns the span between the markers, and a
 * preflight that quietly fixed the file would hide a version skew the pilot
 * needs to resolve in their install, not in their working tree.
 */
function printInstructionDrift(rc: NosediveRc, io: CommandIo): void {
	const installedDigest = renderedSurfaceDigest();
	const installedVersion = nosedivePackageVersion();
	const checkout = isPackageCheckout();
	for (const relativePath of KNOWN_INSTRUCTION_FILES) {
		const path = join(rc.bridgeDir, relativePath);
		if (!existsSync(path)) continue;
		const lines = readFileSync(path, "utf8").split(/\r?\n/);
		const beginIndex = lines.indexOf(MANAGED_INSTRUCTIONS_BEGIN);
		if (beginIndex === -1) continue;
		const stamp = SURFACE_STAMP_PATTERN.exec(lines[beginIndex + 1] ?? "");
		const line = describeInstructionDrift({
			file: relativePath,
			stamped: stamp ? { version: stamp[1]!, digest: stamp[2]! } : undefined,
			installedVersion,
			installedDigest,
			isCheckout: checkout,
		});
		if (line) io.log(line);
	}
}

function printSessionReport(
	rc: NosediveRc,
	levelLine: string,
	freshness: BridgeFreshness,
	agentGuidance: string[],
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
	const bridgeRepoDoc =
		rc.bridge && rc.kbDir ? readKbDocById(rc.kbDir, rc.bridgeDir, rc.bridge) : undefined;
	const freshnessLine = bridgeFreshnessLine(freshness, bridgeRepoDoc?.repoBaseBranch ?? "main");
	if (freshnessLine) io.log(freshnessLine);
	if (freshness.behind > 0) io.log(STALE_BRIDGE_NOSE);
	printCurrentDiveAndFeat(rc, kbDocs, io);
	io.log("");

	printInstructionDrift(rc, io);

	io.log("== pilot identification ==");
	io.writeOut(pilotIdentityLines(identity));
	io.log("");

	// Identity first, so a reader knows whose dives these are. The backlog is
	// named but not rendered: every dive already sits under the feat that owns
	// it, and the rest of the backlog is a document to open when picking new
	// work rather than one every session pays for whether or not it is read.
	printDives(rc, kbDocs, io);
	io.log("");
	io.log(agentGuidance.join("\n"));
}

/**
 * Level drift is surfaced here and nowhere else: preflight runs once per
 * session, so this is the earliest point at which the pilot can be told, and
 * bailing at the first `jump` instead would cost them the work of choosing
 * what to work on first. A gap with a migration in it blocks -- every other
 * contracted command is refusing already, so preflight fails too; it just
 * fails better.
 */
function preflight(_args: string[], commandDocPath: string | undefined, io: CommandIo): void {
	const agentGuidance = readAgentGuidance(commandDocPath);
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
	printSessionReport(rc, drift.line, freshness, agentGuidance, io);
	if (freshness.behind > 0) io.setExitCode(1);
}

export function run(args: string[], runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(
		(preflightArgs, io) => preflight(preflightArgs, runtime.commandDoc?.path, io),
		args,
	);
}
