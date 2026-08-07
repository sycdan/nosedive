import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { commitMessage } from "../lib/commitProvenance.js";
import {
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
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import {
	collectLandGates,
	DEFAULT_CLOCK,
	parseClockSeconds,
	renderGateReport,
	runLandGates,
} from "../lib/landGates.js";
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";
import { resolveEffortDoc } from "../lib/repoEffortScopes.js";
import { ensureManagedRepoCache, gitRun, resolveRepoDoc } from "../lib/repoWorkspaceCore.js";
import { maybeFetchSource, resetHydratedWorktree, resolveRefCommit } from "../lib/repoWorktrees.js";

function slugForBranch(dive: KbDoc, effort: KbDoc | undefined): string {
	return effort?.name ?? dive.name;
}

function commitsAheadOfPin(worktreePath: string, scopeRef: string, repoId: string): string[] {
	const commits = gitRun(
		worktreePath,
		["rev-list", "--abbrev-commit", `${scopeRef}..HEAD`],
		`failed to list commits ahead of pin for repo ${repoId}`,
	);
	return commits ? commits.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * Push one scoped repo's current HEAD to work-branch-prefix<slug> on its own
 * cloud remote (read-only scopes never reach here).
 *
 * Deliberately by resolved URL rather than by remote name: hydration leaves
 * every worktree with a `remote.origin.pushurl` sentinel so an agent working in
 * it cannot push, and a `pushurl` override applies only to the *named* remote.
 * Landing this way means the isolation is never lifted, not even briefly.
 */
function landRepoScope(worktreePath: string, branch: string): string {
	const url = gitRun(
		worktreePath,
		["config", "--get", "remote.origin.url"],
		`failed to resolve origin URL for ${formatPath(worktreePath)}`,
	);
	gitRun(
		worktreePath,
		["push", url, `HEAD:refs/heads/${branch}`],
		`failed to push ${formatPath(worktreePath)} to ${branch}`,
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
	effortId?: string,
): void {
	const relPath = toPosixPath(relative(bridgeDir, divePath));
	gitRun(bridgeDir, ["add", "--", relPath], "failed to stage landed dive");

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
		gitRun(bridgeDir, ["fetch", remote!], "failed to fetch bridge remote before land push");
		gitRun(
			bridgeDir,
			["merge", "--ff-only", upstream],
			"failed to fast-forward bridge before land push; resolve manually and retry",
		);
		gitRun(
			bridgeDir,
			["commit", "-m", commitMessage(`land(${diveName}): closed`, effortId)],
			"failed to commit landed dive",
		);
		gitRun(
			bridgeDir,
			["push"],
			"failed to push bridge after land; dive is committed locally as a memo",
		);
	} finally {
		if (stashed)
			gitRun(bridgeDir, ["stash", "pop"], "failed to restore stashed bridge state after land push");
	}
}

function parseLandArgs(args: string[]): { clock: string } {
	let clock = DEFAULT_CLOCK;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--clock") {
			const value = args[i + 1];
			if (!value) throw new Error("--clock requires a value");
			clock = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--clock=")) {
			clock = arg.slice("--clock=".length);
			if (!clock) throw new Error("--clock requires a value");
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown land option: ${arg}`);
		throw new Error(`unexpected land argument: ${arg}`);
	}
	return { clock };
}

/**
 * Gates address repos by kb `name`, not uuid: a gate script is read and written
 * by people, and `ctx.repos.nosedive.root` survives a doc being re-minted in a
 * way a hard-coded uuid does not.
 */
function gateRepoContext(
	hydrated: { repoId: string; path: string }[],
	kbDocs: KbDoc[],
	bridgeDir: string,
): Record<string, { root: string }> {
	const repos: Record<string, { root: string }> = {};
	for (const entry of hydrated) {
		const doc = kbDocs.find((candidate) => candidate.id === entry.repoId);
		if (!doc?.name) continue;
		repos[doc.name] = { root: toPosixPath(relative(bridgeDir, entry.path)) };
	}
	return repos;
}

/**
 * Appends the gate report to the dive without closing it, so a refused land
 * leaves the next agent everything it needs and the dive stays jumpable.
 */
function appendGateReportToDive(divePath: string, report: string): void {
	const text = readFileSync(divePath, "utf8");
	const heading = `## Land report ${new Date().toISOString()}`;
	writeFileAtomic(divePath, `${text.trimEnd()}\n\n${heading}\n\n${report}\n`);
}

function land(args: string[], io: CommandIo): void {
	const { clock } = parseLandArgs(args);
	const clockSeconds = parseClockSeconds(clock);
	const rc = readNosediveRc(process.cwd());

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) throw new Error(`no dive, run nosedive into "<something>"`);
	if (marker.error || !marker.id)
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);

	if (!rc.kbDir) throw new Error("land requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.id === marker.id);
	if (!dive) throw new Error(`active dive ${marker.id} not found in kb`);

	const effort = dive.effortRef ? resolveEffortDoc(kbDocs, rc, dive.effortRef) : undefined;
	const slug = slugForBranch(dive, effort);

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
		if (scope.readOnly) {
			if (!scope.ref)
				throw new Error(`land refuses: read-only scope ${scope.repoId} has no pinned ref`);
			const commits = commitsAheadOfPin(path, scope.ref, scope.repoId);
			if (commits.length > 0)
				throw new Error(
					`land refuses: read-only scope ${scope.repoId} is ahead of pinned ref ${scope.ref}: ${commits.join(", ")}`,
				);
			continue;
		}
		writableScopes.push({ scope, path });
	}

	/**
	 * Gates run before anything is published, and all of them run: a dive that
	 * scopes several repos must not half-land, so one blocking failure stops
	 * every push, not just the failing repo's.
	 */
	/**
	 * A dive reaches its feat through `effort:` and its repos through `scopes:`,
	 * neither of which is a link, so all three are seeded as roots. Order is
	 * closest-first, which is what first-seen-wins depends on.
	 */
	const gateRoots = [
		dive,
		...(effort ? [effort] : []),
		...scopes
			.map((scope) => kbDocs.find((doc) => doc.id === scope.repoId))
			.filter((doc): doc is KbDoc => doc !== undefined),
	];
	const gates = collectLandGates(gateRoots, kbDocs, rc.bridgeDir);
	if (gates.length > 0) {
		const outcome = runLandGates(gates, {
			clockSeconds,
			context: {
				bridgeRoot: rc.bridgeDir,
				diveId: dive.id,
				repos: gateRepoContext(
					hydratedWorktrees.map((entry) => ({ repoId: entry.scope.repoId, path: entry.path })),
					kbDocs,
					rc.bridgeDir,
				),
			},
		});
		const report = renderGateReport(gates, outcome, clockSeconds);
		io.log(report);
		if (outcome.failed) {
			/**
			 * Reported rather than thrown: a thrown command's buffered output is
			 * discarded, and the report *is* the refusal. Exit code carries the
			 * failure; the dive keeps the copy the next agent will read.
			 */
			appendGateReportToDive(dive.path, report);
			io.err(
				`land refuses: gates did not pass; nothing was pushed. Report appended to ${formatPath(dive.path)}`,
			);
			io.setExitCode(1);
			return;
		}
	}

	for (const { scope, path } of writableScopes) {
		const branch = `${rc.workBranchPrefix ?? "work/"}${slug}`;
		landRepoScope(path, branch);
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

	commitAndPushLand(rc.bridgeDir, dive.path, dive.name, effort?.id);

	// Marker cleared before reset: the dive is already closed (kind: memo,
	// pushed) at this point, so a reset failure must not leave the marker
	// pointing at a dive that can no longer be jumped/packed/bailed.
	const markerPath = join(rc.workspaceDir!, ".nosedive-ref");
	if (existsSync(markerPath)) unlinkSync(markerPath);

	for (const { scope, path } of hydratedWorktrees) {
		const repoDoc = resolveRepoDoc(kbDocs, scope.repoId);
		const trunk = repoDoc.repoBaseBranch;
		if (!trunk) throw new Error(`land refuses: repo ${scope.repoId} has no trunk setting`);
		const cachePath = ensureManagedRepoCache(repoDoc, rc.bridgeDir);
		// The cache is only fetched when it is first cloned, so without this the
		// pilot is parked on the trunk from before this land's own push.
		maybeFetchSource(cachePath, scope.repoId);
		const commit = resolveRefCommit(cachePath, scope.repoId, trunk);
		resetHydratedWorktree(scope.repoId, path, commit);
	}

	io.log(`landed "${dive.gist}"`);
	io.log(outcome);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(land, args);
}
