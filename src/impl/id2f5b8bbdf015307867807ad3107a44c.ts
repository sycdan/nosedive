import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { assertBridgeInStep } from "../lib/bridgeTrunk.js";
import { commitMessage } from "../lib/commitProvenance.js";
import { LAND_IN_FLIGHT_ENV, NO_ACTIVE_DIVE_ERROR_ID, shellQuote } from "../lib/constants.js";
import { diveGateView } from "../lib/diveGateView.js";
import { attachFailedGatesToDive } from "../lib/gateSession.js";
import {
	formatPath,
	parseMarkdownDoc,
	readNosediveRc,
	stringifyYaml,
	toPosixPath,
} from "../lib/coreParsing.js";
import {
	DiveWipScope,
	hydratedScopedRepoPath,
	readWorkspaceDiveMarker,
	uniqueDiveWipScopes,
} from "../lib/gitState.js";
import { appendTimestampedSection } from "../lib/kbSections.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import {
	bringBridgeScopeIn,
	commitsAheadOfPin,
	headIsStrictlyBehindPin,
	scopeUnchanged,
} from "../lib/landBridgeScope.js";
import { dropSelfRef, refuseMidRebase, settleSelf } from "../lib/selfDiveRef.js";
import { strandedInstancesOnLand } from "../lib/kindInstances.js";
import { rewriteMarkdownLinks } from "../lib/markdownLinks.js";
import { removeDiveScratch } from "../lib/diveScratch.js";
import {
	collectFeatGates,
	gateRepoContext,
	renderGateReport,
	runLandGates,
} from "../lib/landGates.js";
import { describeDirtyGates, dirtyGates } from "../lib/gateFreshness.js";
import { gitOutput } from "../lib/gitProcess.js";
import { leaseRefusal, movedBranchRefusal } from "../lib/landRefusals.js";
import { headContains, landRepoScope, remoteBranchHead } from "../lib/landPush.js";
import { nosediveInvocation } from "../lib/packageBacklog.js";
import { printNextSteps } from "../lib/nextSteps.js";
import { writeFileAtomic } from "../lib/renderPlan.js";
import { bridgeFeatPath, reconcileDiveFeatLinks, resolveFeatDoc } from "../lib/repoFeatScopes.js";
import { gitRun } from "../lib/repoWorkspaceCore.js";
import { upscopeBranch } from "../lib/diveScopes.js";

const refusalPrefix = "land refused because ";

function dirtyWorktreeStatus(worktreePath: string, repoId: string): string[] {
	const status = gitRun(
		worktreePath,
		["status", "--porcelain"],
		`failed to read dirty status for repo ${repoId}`,
	);
	return status.split(/\r?\n/).filter(Boolean);
}

/**
 * Every writable scope's push is decided before a single gate runs.
 *
 * The push is the last thing land does and the first thing that can be refused
 * for a reason nothing local knows about: the work branch moved. On the second
 * and every later dive of a feat that is not an edge case but the norm -- the
 * previous dive's land moved the branch past this dive's pin -- so the ordinary
 * path was to spend the whole gate suite before learning the push could never
 * have worked. One `ls-remote` per scope buys that answer up front, and the
 * refusal names the recovery instead of leaving the pilot to know it.
 */
function assertScopesCanPublish(
	writableScopes: { scope: DiveWipScope; path: string }[],
	hard: boolean,
	dive: KbDoc,
	cli: string,
): void {
	for (const { scope, path } of writableScopes) {
		const branch = scope.workBranch!;
		const pin = scope.ref!;
		const published = remoteBranchHead(path, branch, scope.repoId);

		if (hard) {
			// The lease expects the branch to stand exactly where this dive pinned it;
			// an absent branch fails it too, which is what keeps --hard from creating one.
			if (published !== pin)
				throw new Error(leaseRefusal(branch, { repoId: scope.repoId, pin, diveId: dive.id, cli }));
			continue;
		}

		// An absent branch is created by the push; a branch HEAD already contains
		// is a fast-forward. Everything else is refused here rather than after gates.
		if (published === undefined || headContains(path, published)) continue;

		if (published === pin) {
			throw new Error(
				`${refusalPrefix}scope ${scope.repoId} does not descend from ${branch}, which still stands ` +
					`at this dive's pin ${pin} -- this dive rewrote that history rather than building on it. ` +
					`Nothing was pushed and no gates ran. Publish the rewrite under a lease with ` +
					`\`${cli} land --hard\`, or rebase onto ${pin} to land as a fast-forward.`,
			);
		}

		throw new Error(
			`${movedBranchRefusal(branch, published, { repoId: scope.repoId, pin, diveId: dive.id, cli })} ` +
				`Nothing was pushed and no gates ran.`,
		);
	}
}

function stashExceptStaged(bridgeDir: string): boolean {
	const before = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	gitRun(
		bridgeDir,
		["stash", "push", "--keep-index", "-m", "nosedive land: temporary stash"],
		"failed to stash bridge state before land push",
	);
	const after = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	return before !== after;
}

/**
 * The bridge upstream `land` needs to close the dive, resolved before anything
 * is published. The check used to sit inside `commitAndPushLand`, which runs
 * after every work branch is already on its remote: a bridge with no upstream
 * therefore published the work and then refused, leaving the dive open with
 * nothing to retry -- landing again cannot un-push a branch. A bridge diverged
 * from its upstream is refused here too, for the same reason.
 */
function bridgeUpstreamForLand(bridgeDir: string): string {
	const upstream = assertBridgeInStep(bridgeDir);
	if (!upstream) throw new Error("bridge has no upstream to push to; configure one before landing");
	return upstream;
}

function commitAndPushLand(
	bridgeDir: string,
	divePath: string,
	diveName: string,
	upstream: string,
	io: CommandIo,
	featId?: string,
	featPath?: string,
): void {
	io.err("land: closing bridge dive");
	const relPath = toPosixPath(relative(bridgeDir, divePath));
	gitRun(
		bridgeDir,
		["add", "--", relPath, ...(featPath ? [toPosixPath(relative(bridgeDir, featPath))] : [])],
		"failed to stage landed dive",
	);

	const stashed = stashExceptStaged(bridgeDir);
	try {
		const [remote] = upstream.split("/");
		io.err(`land: syncing bridge from ${upstream}`);
		gitRun(bridgeDir, ["fetch", remote!], "failed to fetch bridge remote before land push");
		gitRun(
			bridgeDir,
			["merge", "--ff-only", upstream],
			"failed to fast-forward bridge before land push; resolve manually and retry",
		);
		io.err("land: committing bridge outcome");
		gitRun(
			bridgeDir,
			["commit", "-m", commitMessage(`land(${diveName}): closed`, featId)],
			"failed to commit landed dive",
		);
		io.err("land: pushing bridge");
		gitRun(
			bridgeDir,
			["push"],
			"failed to push bridge after land; dive is committed locally as a memo",
		);
		io.err("land: bridge push complete");
	} finally {
		if (stashed)
			gitRun(bridgeDir, ["stash", "pop"], "failed to restore stashed bridge state after land push");
	}
}

function parseLandArgs(args: string[]): { hard: boolean } {
	let hard = false;
	for (const arg of args) {
		if (arg === "--hard") {
			hard = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown land option: ${arg}`);
		throw new Error(`unexpected land argument: ${arg}`);
	}
	return { hard };
}

/**
 * Appends the gate report to the dive without closing it. A refused land leaves
 * the next agent everything it needs and the dive stays jumpable; a passing one
 * leaves the record of what was checked before the work was published.
 */
function appendGateReportToDive(divePath: string, report: string): void {
	appendTimestampedSection(divePath, report, "Land report");
}

async function landDive(args: string[], io: CommandIo): Promise<void> {
	const { hard } = parseLandArgs(args);
	const rc = readNosediveRc(process.cwd());

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) throw new Error(NO_ACTIVE_DIVE_ERROR_ID);
	if (marker.error || !marker.id)
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);

	/**
	 * Recursion is landing the dive that is already landing, not merely landing
	 * from inside a land: a gate that walks a second bridge lands a dive of its
	 * own, and refusing that would fail every land the gate runs on.
	 *
	 * @see kb/01a06f5e-f003-7b1b-8a63-919d36015e31.md
	 */
	if (process.env[LAND_IN_FLIGHT_ENV] === marker.id)
		throw new Error(
			`land is already in flight for dive ${marker.id}, and landing it from inside that land ` +
				`would publish the same work twice. This is usually a pre-push hook that runs ` +
				`\`nosedive land\`: take the land out of the hook. To allow a nested land on purpose, unset ` +
				`${LAND_IN_FLIGHT_ENV} in the hook.`,
		);

	// Everything past here can push, and a push runs the scoped repo's own
	// pre-push hook. `land` clears this again once the whole run is over.
	process.env[LAND_IN_FLIGHT_ENV] = marker.id;

	if (!rc.kbDir) throw new Error("land requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.id === marker.id);
	if (!dive) throw new Error(`active dive ${marker.id} not found in kb`);

	const feat = dive.featRef ? resolveFeatDoc(kbDocs, rc, dive.featRef) : undefined;
	const cli = nosediveInvocation();

	// Before the scope loop, the gates and every push: see `bridgeUpstreamForLand`.
	const upstream = bridgeUpstreamForLand(rc.bridgeDir);

	const { scopes, failures } = uniqueDiveWipScopes(dive.scopes);
	if (failures.length > 0) {
		throw new Error(`${refusalPrefix}${failures.map((f) => f.reasons.join("; ")).join(" | ")}`);
	}
	for (const scope of scopes) {
		if (!scope.ref)
			throw new Error(`${refusalPrefix}scoped repo ${scope.repoId} has no pinned ref`);
	}

	const scopeOutcomes: string[] = [];
	const hydratedWorktrees: { scope: (typeof scopes)[number]; path: string }[] = [];
	let writableScopes: { scope: (typeof scopes)[number]; path: string }[] = [];
	for (const scope of scopes) {
		if (!rc.workspaceDir) throw new Error("no workspace is configured; run nosedive seed");
		const { path, failure } = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (failure) throw new Error(`${refusalPrefix}${failure.reasons.join("; ")}`);
		if (!path) continue; // scope never hydrated -- nothing to land for this repo
		hydratedWorktrees.push({ scope, path });
		// Always writable, whatever its branch says: land publishes it by bringing it into the bridge.
		if (scope.repoId === rc.bridge) {
			refuseMidRebase(path, "land");
			writableScopes.push({ scope, path });
			continue;
		}
		if (!scope.workBranch) {
			const suggested = upscopeBranch(scope.repoId, undefined, rc, kbDocs, feat);
			const branchHint = suggested
				? ` to publish it on ${suggested}, or pass --work-branch to choose another`
				: " with --work-branch to name where it publishes";
			if (!scope.ref) throw new Error(`${refusalPrefix}scope ${scope.repoId} has no pinned ref`);
			const commits = commitsAheadOfPin(path, scope.ref, scope.repoId);
			/**
			 * Work with nowhere to go. Naming the fix matters more than naming the
			 * rule here: the pilot is looking at commits they have already made, and
			 * the only question left is which branch they belong on.
			 */
			if (commits.length > 0)
				throw new Error(
					`${refusalPrefix}scope ${scope.repoId} is ahead of pinned ref ${scope.ref} ` +
						`(${commits.join(", ")}) and names no work branch. ` +
						`Run \`${cli} record.dive --ref ${dive.id} --upscope ${scope.repoId}\`${branchHint}.`,
				);
			if (headIsStrictlyBehindPin(path, scope.ref))
				throw new Error(
					`${refusalPrefix}scope ${scope.repoId} is behind pinned ref ${scope.ref} and names no work branch. ` +
						`Run \`${cli} record.dive --ref ${dive.id} --upscope ${scope.repoId}\`${branchHint}.`,
				);
			continue;
		}
		writableScopes.push({ scope, path });
	}

	const dirtyScopes = hydratedWorktrees
		.map(({ scope, path }) => ({ scope, path, status: dirtyWorktreeStatus(path, scope.repoId) }))
		.filter((entry) => entry.status.length > 0);
	if (dirtyScopes.length > 0) {
		const detail = dirtyScopes
			.map(
				({ scope, path, status }) =>
					`scope ${scope.repoId} at ${formatPath(path)}:\n${status
						.map((line) => `  ${line}`)
						.join("\n")}\n\nSuggested git commands:\n` +
					`  git -C ${shellQuote(formatPath(path))} add -A\n` +
					`  git -C ${shellQuote(formatPath(path))} commit -m ${shellQuote(dive.gist)}`,
			)
			.join("\n\n");
		throw new Error(
			`${refusalPrefix}scoped worktree(s) are dirty; commit, pack, or stash changes before landing.\n${detail}`,
		);
	}

	// Committed in the feat's repo before anything is weighed, so it publishes with the dive's work there.
	if (feat?.home) reconcileDiveFeatLinks(feat, feat, dive.id, "landed.dive", { scoping: dive, io });
	// A writable scope with nothing of the dive's past its pin has nothing to
	// publish, so it is not pushed: every dive takes the backlog's scopes, and most never touch them.
	const unchanged = writableScopes.filter(({ scope, path }) => scopeUnchanged(scope, path, rc));
	writableScopes = writableScopes.filter((entry) => !unchanged.includes(entry));

	assertScopesCanPublish(writableScopes, hard, dive, cli);

	// A schema change that strands its own instances would publish broken docs.
	const stranded = strandedInstancesOnLand(writableScopes, kbDocs, io);
	if (stranded) throw new Error(`${refusalPrefix}${stranded}`);

	/**
	 * Gates run before anything is published, and all of them run: a dive that
	 * scopes several repos must not half-land, so one blocking failure stops
	 * every push, not just the failing repo's.
	 */
	/**
	 * A dive reaches its feat through `feat:` and its repos through `scopes:`,
	 * neither of which is a link, so all three are seeded as roots. Order is
	 * closest-first, which is what first-seen-wins depends on.
	 */
	/**
	 * A repo's own gates run only when the dive changed that repo: on an
	 * untouched repo they would judge trunk, not this dive, and a breakage
	 * already there would block unrelated work. Dirty scopes were refused
	 * above, so a change is a commit past the pin.
	 */
	const gateDocs = diveGateView(kbDocs, dive, rc);
	const gateRoots = [
		dive,
		...(feat ? [feat] : []),
		...hydratedWorktrees
			.filter(({ scope, path }) => commitsAheadOfPin(path, scope.ref!, scope.repoId).length > 0)
			.map(({ scope }) => kbDocs.find((doc) => doc.id === scope.repoId))
			.filter((doc): doc is KbDoc => doc !== undefined),
	];
	const gates = collectFeatGates(
		"land",
		gateRoots
			.map(
				(doc) =>
					gateDocs.find((entry) => entry.id === doc.id) ??
					(kbDocs.some((entry) => entry.id === doc.id) ? undefined : doc),
			)
			.filter((doc): doc is KbDoc => doc !== undefined),
		gateDocs,
		rc.bridgeDir,
	);
	// Before the run, not after: a gate whose source differs from what will be
	// published has already made its own result meaningless, green or red. Before
	// the stash too, which is why no pre-push hook can stand in for this.
	const stale = dirtyGates(rc.bridgeDir, gates);
	if (stale.length > 0) {
		throw new Error(
			`${refusalPrefix}a gate would publish as something other than what just ran:
` + describeDirtyGates(stale),
		);
	}
	io.err(
		`land: ${gates.length === 0 ? "no land gates selected" : `running ${gates.length} land gate${gates.length === 1 ? "" : "s"}`}`,
	);
	if (gates.length > 0) {
		const outcome = await runLandGates(gates, {
			// Live gate output goes to stderr, where a gate's own progress already
			// goes. The report on stdout keeps a copy only for a gate that failed,
			// so watching the run is the way to read a passing gate's chatter.
			sink: { out: (text) => io.writeErr(text), err: (text) => io.writeErr(text) },
			context: {
				bridgeRoot: rc.bridgeDir,
				diveId: dive.id,
				featId: feat?.id,
				repos: gateRepoContext(
					hydratedWorktrees.map((entry) => ({ repoId: entry.scope.repoId, path: entry.path })),
					kbDocs,
					rc.bridgeDir,
				),
			},
		});
		const report = renderGateReport(gates, outcome, dive);
		io.log(rewriteMarkdownLinks(report, dirname(dive.path), process.cwd()));
		/**
		 * Written whether or not the gates passed. Appending only on failure makes a
		 * landed dive read as one that landed red: the refusal is the only gate
		 * section left in it, and the run that actually cleared the way leaves
		 * nothing behind. `## Outcome` is written afterwards from a re-read of the
		 * file, so the report a land acted on sits above the push it allowed.
		 */
		appendGateReportToDive(dive.path, report);
		if (outcome.failed) {
			/**
			 * Reported rather than thrown: a thrown command's buffered output is
			 * discarded, and the report *is* the refusal. Exit code carries the
			 * failure; the dive keeps the copy the next agent will read.
			 */
			attachFailedGatesToDive(dive.path, dive.links, outcome.runs);
			io.err(
				`${refusalPrefix}gates did not pass; nothing was pushed. Report appended to ${formatPath(dive.path)}`,
			);
			io.setExitCode(1);
			return;
		}
		io.err("land: land gates passed");
	}

	// Before any push, so a refusal leaves every work branch where it was.
	bringBridgeScopeIn(writableScopes, rc, io);
	for (const { scope, path } of writableScopes) {
		// Brought in above; the bridge push below publishes it.
		if (scope.repoId === rc.bridge) {
			scopeOutcomes.push(`${scope.repoId} -> the bridge`);
			continue;
		}
		// Only scopes naming a branch reach here, so there is nothing to fall back to.
		const branch = scope.workBranch!;
		/**
		 * Every scope was refused above unless it carries a pinned ref, so a lease
		 * always has an expected value to name. That check is what keeps `--hard`
		 * honest: a `--force-with-lease` with nothing to expect is an
		 * unconditional force wearing the flag's name, so there is deliberately no
		 * weaker push to fall back to here.
		 */
		const publishScope = { repoId: scope.repoId, pin: scope.ref!, diveId: dive.id, cli };
		io.err(`land: pushing scope ${scope.repoId} -> ${branch}`);
		landRepoScope(path, branch, publishScope, hard);
		io.err(`land: pushed scope ${scope.repoId} -> ${branch}`);
		scopeOutcomes.push(`${scope.repoId} -> ${branch}`);
	}
	for (const { scope } of unchanged) {
		io.err(`land: scope ${scope.repoId} unchanged; not pushed`);
		scopeOutcomes.push(`${scope.repoId} unchanged; not pushed`);
	}

	const text = readFileSync(dive.path, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(dive.path));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in frontmatter in ${formatPath(dive.path)}`);
	doc.set("kind", "memo");

	const outcome =
		scopeOutcomes.length > 0
			? scopeOutcomes.map((line) => `- ${line}`).join("\n")
			: "- (no scoped repos to push)";
	const body = `${parsed.body.trimEnd()}\n\n## Outcome\n\n${dive.gist}\n\n${outcome}\n`;
	writeFileAtomic(dive.path, ["---", stringifyYaml(doc).trimEnd(), "---", body].join("\n"));
	if (feat) reconcileDiveFeatLinks(feat, feat, dive.id, "landed.dive");

	const featPath = bridgeFeatPath(feat);
	commitAndPushLand(rc.bridgeDir, dive.path, dive.name, upstream, io, feat?.id, featPath);
	// The bridge now holds __self's work under other hashes; the next dive starts from it.
	const self = hydratedWorktrees.find(({ scope }) => scope.repoId === rc.bridge);
	if (self) {
		settleSelf(rc.bridgeDir, self.path);
		dropSelfRef(self.path, dive.id);
	}

	// The dive is closed and published before its active-work marker is cleared.
	const markerPath = join(rc.workspaceDir!, ".nosedive-ref");
	if (existsSync(markerPath)) unlinkSync(markerPath);
	removeDiveScratch(rc.workspaceDir!, dive.id);

	io.log(`landed "${dive.gist}"`);
	io.log(outcome);
	printNextSteps(io, ["nosedive preflight"]);
}

/** Keeps the in-flight marker from outliving the land that set it. */
async function land(args: string[], io: CommandIo): Promise<void> {
	try {
		await landDive(args, io);
	} finally {
		delete process.env[LAND_IN_FLIGHT_ENV];
	}
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(land, args);
}
