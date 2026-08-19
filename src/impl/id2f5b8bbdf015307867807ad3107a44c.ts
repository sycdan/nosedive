import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { commitMessage } from "../lib/commitProvenance.js";
import { NO_ACTIVE_DIVE_ERROR_ID, shellQuote } from "../lib/constants.js";
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
	hydratedScopedRepoPath,
	readWorkspaceDiveMarker,
	uniqueDiveWipScopes,
} from "../lib/gitState.js";
import { appendTimestampedSection } from "../lib/kbSections.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { removeDiveScratch } from "../lib/diveScratch.js";
import {
	collectFeatGates,
	gateRepoContext,
	renderGateReport,
	runLandGates,
} from "../lib/landGates.js";
import { gitOutput } from "../lib/gitProcess.js";
import { nosediveInvocation } from "../lib/packageBacklog.js";
import { writeFileAtomic } from "../lib/renderPlan.js";
import { reconcileDiveFeatLinks, resolveFeatDoc } from "../lib/repoFeatScopes.js";
import { gitRun } from "../lib/repoWorkspaceCore.js";

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

function dirtyWorktreeStatus(worktreePath: string, repoId: string): string[] {
	const status = gitRun(
		worktreePath,
		["status", "--porcelain"],
		`failed to read dirty status for repo ${repoId}`,
	);
	return status.split(/\r?\n/).filter(Boolean);
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
	const url = gitRun(
		worktreePath,
		["config", "--get", "remote.origin.url"],
		`failed to resolve origin URL for ${formatPath(worktreePath)}`,
	);
	const force = lease ? [`--force-with-lease=refs/heads/${branch}:${lease.pin}`] : [];
	gitRun(
		worktreePath,
		["push", url, ...force, `HEAD:refs/heads/${branch}`],
		lease
			? `land refuses: scope ${lease.repoId} could not replace ${branch} under a lease expecting ` +
					`${lease.pin} -- the branch moved since this dive was pinned, or does not exist. ` +
					`Repin the dive at the new branch head (\`${lease.cli} record.dive --ref ${lease.diveId} ` +
					`--repin\`) and rebase again; do not force-push past it, which would discard whatever ` +
					`moved it`
			: `failed to push ${formatPath(worktreePath)} to ${branch}`,
	);
	return branch;
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

function commitAndPushLand(
	bridgeDir: string,
	divePath: string,
	diveName: string,
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
		const upstream = gitOutput(bridgeDir, [
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{upstream}",
		]);
		if (!upstream)
			throw new Error("bridge has no upstream to push to; configure one before landing");
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
 * Appends the gate report to the dive without closing it, so a refused land
 * leaves the next agent everything it needs and the dive stays jumpable.
 */
function appendGateReportToDive(divePath: string, report: string): void {
	appendTimestampedSection(divePath, report, "Land report");
}

async function land(args: string[], io: CommandIo): Promise<void> {
	const { hard } = parseLandArgs(args);
	const rc = readNosediveRc(process.cwd());

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) throw new Error(NO_ACTIVE_DIVE_ERROR_ID);
	if (marker.error || !marker.id)
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);

	if (!rc.kbDir) throw new Error("land requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.id === marker.id);
	if (!dive) throw new Error(`active dive ${marker.id} not found in kb`);

	const feat = dive.featRef ? resolveFeatDoc(kbDocs, rc, dive.featRef) : undefined;
	const slug = slugForBranch(dive, feat);
	const cli = nosediveInvocation();

	const { scopes, failures } = uniqueDiveWipScopes(dive.scopes);
	if (failures.length > 0) {
		throw new Error(`land refuses: ${failures.map((f) => f.reasons.join("; ")).join(" | ")}`);
	}
	for (const scope of scopes) {
		if (!scope.ref) throw new Error(`land refuses: scoped repo ${scope.repoId} has no pinned ref`);
	}

	const pushed: string[] = [];
	const hydratedWorktrees: { scope: (typeof scopes)[number]; path: string }[] = [];
	const writableScopes: { scope: (typeof scopes)[number]; path: string }[] = [];
	for (const scope of scopes) {
		if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");
		const { path, failure } = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (failure) throw new Error(`land refuses: ${failure.reasons.join("; ")}`);
		if (!path) continue; // scope never hydrated -- nothing to land for this repo
		hydratedWorktrees.push({ scope, path });
		if (!scope.workBranch) {
			if (!scope.ref) throw new Error(`land refuses: scope ${scope.repoId} has no pinned ref`);
			const commits = commitsAheadOfPin(path, scope.ref, scope.repoId);
			/**
			 * Work with nowhere to go. Naming the fix matters more than naming the
			 * rule here: the pilot is looking at commits they have already made, and
			 * the only question left is which branch they belong on.
			 */
			if (commits.length > 0)
				throw new Error(
					`land refuses: scope ${scope.repoId} is ahead of pinned ref ${scope.ref} ` +
						`(${commits.join(", ")}) and names no work branch. ` +
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
			`land refuses: scoped worktree(s) are dirty; commit, pack, or stash changes before landing.\n${detail}`,
		);
	}

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
	io.err(
		`land: ${gates.length === 0 ? "no land gates selected" : `running ${gates.length} land gate${gates.length === 1 ? "" : "s"}`}`,
	);
	if (gates.length > 0) {
		const outcome = await runLandGates(gates, {
			// Live gate output goes to stderr, where a gate's own progress already
			// goes; the recorded report keeps its copy and still lands on stdout.
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
		const report = renderGateReport(gates, outcome);
		io.log(report);
		if (outcome.failed) {
			/**
			 * Reported rather than thrown: a thrown command's buffered output is
			 * discarded, and the report *is* the refusal. Exit code carries the
			 * failure; the dive keeps the copy the next agent will read.
			 */
			appendGateReportToDive(dive.path, report);
			attachFailedGatesToDive(dive.path, dive.links, outcome.runs);
			io.err(
				`land refuses: gates did not pass; nothing was pushed. Report appended to ${formatPath(dive.path)}`,
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
		 * No pin, no lease -- and never a weaker push instead. A `--hard` land that
		 * cannot say what it expects to replace is an unconditional force wearing
		 * the flag's name, so it is refused before anything is published.
		 */
		if (hard && !scope.ref)
			throw new Error(
				`land refuses: scope ${scope.repoId} has no pinned ref, so --hard has no expected ` +
					`value to lease against; land will not force a push it cannot condition`,
			);
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

	commitAndPushLand(rc.bridgeDir, dive.path, dive.name, io, feat?.id, feat?.path);

	// The dive is closed and published before its active-work marker is cleared.
	const markerPath = join(rc.workspaceDir!, ".nosedive-ref");
	if (existsSync(markerPath)) unlinkSync(markerPath);
	removeDiveScratch(rc.workspaceDir!, dive.id);

	io.log(`landed "${dive.gist}"`);
	io.log(outcome);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(land, args);
}
