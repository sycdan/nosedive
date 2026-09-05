import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { commitMessage } from "../lib/commitProvenance.js";
import { LAND_IN_FLIGHT_ENV, NO_ACTIVE_DIVE_ERROR_ID, shellQuote } from "../lib/constants.js";
import { attachFailedGatesToDive } from "../lib/gateSession.js";
import {
	defaultWorkBranch,
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
import { nosediveInvocation } from "../lib/packageBacklog.js";
import { printNextSteps } from "../lib/nextSteps.js";
import { writeFileAtomic } from "../lib/renderPlan.js";
import { reconcileDiveFeatLinks, resolveFeatDoc } from "../lib/repoFeatScopes.js";
import { gitRun } from "../lib/repoWorkspaceCore.js";

const refusalPrefix = "land refused because ";

/** The explicit expected value of a `--hard` push, plus what a refusal must name. */
interface LandLease {
	repoId: string;
	pin: string;
	diveId: string;
	cli: string;
}

function slugForBranch(dive: KbDoc, feat: KbDoc | undefined): string {
	return feat?.name ?? dive.name;
}

function commitsAheadOfPin(worktreePath: string, scopeRef: string, repoId: string): string[] {
	const commits = gitRun(
		worktreePath,
		["rev-list", "--abbrev-commit", `${scopeRef}..HEAD`],
		`failed to list commits ahead of pin for repo ${repoId}`,
	);
	return commits ? commits.split(/\r?\n/).filter(Boolean) : [];
}

function headIsStrictlyBehindPin(worktreePath: string, scopeRef: string): boolean {
	const head = gitOutput(worktreePath, ["rev-parse", "HEAD"]);
	if (!head || head === scopeRef) return false;
	return gitOutput(worktreePath, ["merge-base", "--is-ancestor", "HEAD", scopeRef]) !== undefined;
}

function dirtyWorktreeStatus(worktreePath: string, repoId: string): string[] {
	const status = gitRun(
		worktreePath,
		["status", "--porcelain"],
		`failed to read dirty status for repo ${repoId}`,
	);
	return status.split(/\r?\n/).filter(Boolean);
}

function originUrl(worktreePath: string): string {
	return gitRun(
		worktreePath,
		["config", "--get", "remote.origin.url"],
		`failed to resolve origin URL for ${formatPath(worktreePath)}`,
	);
}

/** Shared by the pre-gate check and the push itself, so both refusals read alike. */
function leaseRefusal(branch: string, lease: LandLease): string {
	return (
		`${refusalPrefix}scope ${lease.repoId} could not replace ${branch} under a lease expecting ` +
		`${lease.pin} -- the branch moved since this dive was pinned, or does not exist. ` +
		`Repin the dive at the new branch head (\`${lease.cli} record.dive --ref ${lease.diveId} ` +
		`--repin\`) and rebase again; do not force-push past it, which would discard whatever ` +
		`moved it`
	);
}

/**
 * Push one scoped repo's current HEAD to work-branch-prefix<slug> on its own
 * cloud remote (read-only scopes never reach here).
 *
 * Deliberately by resolved URL rather than by remote name: hydration leaves
 * every worktree with a `remote.origin.pushurl` sentinel so an agent working in
 * it cannot push, and a `pushurl` override applies only to the *named* remote.
 * Landing this way means the isolation is never lifted, not even briefly.
 *
 * `lease` carries the `--hard` case. Its expected value is spelled out rather
 * than left to git: a URL push maintains no `refs/remotes/origin/<branch>`, and
 * a valueless `--force-with-lease` resolved against a ref that does not exist
 * is a silent unconditional force. Naming the dive's own pin is also what gives
 * the flag its meaning -- replace the branch only while it still stands where
 * this dive started -- and refuses an absent branch for free, since git rejects
 * a non-empty expected value against a ref that is not there.
 */
function landRepoScope(worktreePath: string, branch: string, lease?: LandLease): string {
	const url = originUrl(worktreePath);
	const force = lease ? [`--force-with-lease=refs/heads/${branch}:${lease.pin}`] : [];
	gitRun(
		worktreePath,
		["push", url, ...force, `HEAD:refs/heads/${branch}`],
		lease ? leaseRefusal(branch, lease) : `failed to push ${formatPath(worktreePath)} to ${branch}`,
	);
	return branch;
}

/** The published head of `branch` on the scope's own remote, or undefined when it has none. */
function remoteBranchHead(
	worktreePath: string,
	branch: string,
	repoId: string,
): string | undefined {
	const line = gitRun(
		worktreePath,
		["ls-remote", originUrl(worktreePath), `refs/heads/${branch}`],
		`${refusalPrefix}the published head of ${branch} on scope ${repoId}'s remote could not be read`,
	);
	return line ? line.split(/\s+/)[0] : undefined;
}

/**
 * Whether this worktree's HEAD already contains `sha`. A commit the worktree
 * does not have cannot be an ancestor of its HEAD, so a `merge-base` that fails
 * on a missing object answers the same question correctly.
 */
function headContains(worktreePath: string, sha: string): boolean {
	return gitOutput(worktreePath, ["merge-base", "--is-ancestor", sha, "HEAD"]) !== undefined;
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
			`${refusalPrefix}scope ${scope.repoId} cannot fast-forward ${branch}: the branch is at ` +
				`${published} and this dive's work does not contain it (pinned at ${pin}). ` +
				`Nothing was pushed and no gates ran. Repin onto the published head and replay this ` +
				`dive's work onto it:\n` +
				`  ${cli} pack\n` +
				`  ${cli} record.dive --ref ${dive.id} --repin\n` +
				`  ${cli} jump ${dive.id}\n` +
				`then land again.`,
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
 * nothing to retry -- landing again cannot un-push a branch.
 */
function bridgeUpstreamForLand(bridgeDir: string): string {
	const upstream = gitOutput(bridgeDir, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
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
	const slug = slugForBranch(dive, feat);
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

	const pushed: string[] = [];
	const hydratedWorktrees: { scope: (typeof scopes)[number]; path: string }[] = [];
	const writableScopes: { scope: (typeof scopes)[number]; path: string }[] = [];
	for (const scope of scopes) {
		if (!rc.workspaceDir) throw new Error("no workspace is configured; run nosedive seed");
		const { path, failure } = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (failure) throw new Error(`${refusalPrefix}${failure.reasons.join("; ")}`);
		if (!path) continue; // scope never hydrated -- nothing to land for this repo
		hydratedWorktrees.push({ scope, path });
		if (!scope.workBranch) {
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
						`Run \`${cli} record.dive --ref ${dive.id} --upscope ${scope.repoId}\` to publish it on ` +
						`${defaultWorkBranch(rc, slug)}, or pass --work-branch to choose another -- that default is ` +
						`nosedive's, and this repo's own branch convention may differ, so check before landing.`,
				);
			if (headIsStrictlyBehindPin(path, scope.ref))
				throw new Error(
					`${refusalPrefix}scope ${scope.repoId} is behind pinned ref ${scope.ref} and names no work branch. ` +
						`Run \`${cli} record.dive --ref ${dive.id} --upscope ${scope.repoId}\` to publish it on ` +
						`${defaultWorkBranch(rc, slug)}, or pass --work-branch to choose another -- that default is ` +
						`nosedive's, and this repo's own branch convention may differ, so check before landing.`,
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

	assertScopesCanPublish(writableScopes, hard, dive, cli);

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
	const gateRoots = [
		dive,
		...(feat ? [feat] : []),
		...scopes
			.map((scope) => kbDocs.find((doc) => doc.id === scope.repoId))
			.filter((doc): doc is KbDoc => doc !== undefined),
	];
	const gates = collectFeatGates("land", gateRoots, kbDocs, rc.bridgeDir);
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

	for (const { scope, path } of writableScopes) {
		// Only scopes naming a branch reach here, so there is nothing to fall back to.
		const branch = scope.workBranch!;
		/**
		 * Every scope was refused above unless it carries a pinned ref, so a lease
		 * always has an expected value to name. That check is what keeps `--hard`
		 * honest: a `--force-with-lease` with nothing to expect is an
		 * unconditional force wearing the flag's name, so there is deliberately no
		 * weaker push to fall back to here.
		 */
		const lease = hard
			? { repoId: scope.repoId, pin: scope.ref!, diveId: dive.id, cli }
			: undefined;
		io.err(`land: pushing scope ${scope.repoId} -> ${branch}`);
		landRepoScope(path, branch, lease);
		io.err(`land: pushed scope ${scope.repoId} -> ${branch}`);
		pushed.push(`${scope.repoId} -> ${branch}`);
	}

	const text = readFileSync(dive.path, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(dive.path));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in frontmatter in ${formatPath(dive.path)}`);
	doc.set("kind", "memo");

	const outcome =
		pushed.length > 0
			? pushed.map((line) => `- ${line}`).join("\n")
			: "- (no scoped repos to push)";
	const body = `${parsed.body.trimEnd()}\n\n## Outcome\n\n${dive.gist}\n\n${outcome}\n`;
	writeFileAtomic(dive.path, ["---", stringifyYaml(doc).trimEnd(), "---", body].join("\n"));
	if (feat) reconcileDiveFeatLinks(feat, feat, dive.id, "landed.dive");

	commitAndPushLand(rc.bridgeDir, dive.path, dive.name, upstream, io, feat?.id, feat?.path);

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
