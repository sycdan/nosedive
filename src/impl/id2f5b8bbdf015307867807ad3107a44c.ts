import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
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
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";
import { gitRun, maybeResolveRepoDoc } from "../lib/repoWorkspaceCore.js";
import { removeHydratedWorktree } from "../lib/repoWorktrees.js";

function slugForBranch(dive: KbDoc, effort: KbDoc | undefined): string {
	return effort?.name ?? dive.name;
}

function branchForRepo(repo: KbDoc, slug: string, fallbackPrefix: string): string {
	return `${repo.metaScalars["branch-prefix"] ?? fallbackPrefix}${slug}`;
}

function runRepoCheck(repo: KbDoc, worktreePath: string): void {
	const check = repo.metaScalars.check;
	if (!check) return;
	const result = spawnSync(check, {
		cwd: worktreePath,
		encoding: "utf8",
		shell: true,
	});
	if (result.status === 0) return;
	const detail = result.stderr?.trim() || result.stdout?.trim() || "unknown error";
	throw new Error(`repo ${repo.id} check failed (${check}): ${detail}`);
}

function commitsAheadOfPin(worktreePath: string, scopeRef: string, repoId: string): string[] {
	const commits = gitRun(
		worktreePath,
		["rev-list", "--abbrev-commit", `${scopeRef}..HEAD`],
		`failed to list commits ahead of pin for repo ${repoId}`,
	);
	return commits ? commits.split(/\r?\n/).filter(Boolean) : [];
}

/** Push one scoped repo's current HEAD to work-branch-prefix<slug> on its own `origin`
 * (already set up by hydration; read-only scopes never reach here). */
function landRepoScope(worktreePath: string, branch: string): string {
	gitRun(
		worktreePath,
		["push", "origin", `HEAD:refs/heads/${branch}`],
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

function commitAndPushLand(bridgeDir: string, divePath: string, diveName: string): void {
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
			["commit", "-m", `land(${diveName}): closed`],
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

function land(_args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) throw new Error(`no dive, run nosedive into "<something>"`);
	if (marker.error || !marker.id)
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);

	if (!rc.kbDir) throw new Error("land requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.id === marker.id);
	if (!dive) throw new Error(`active dive ${marker.id} not found in kb`);

	const effort = dive.effortRef ? kbDocs.find((doc) => doc.id === dive.effortRef) : undefined;
	const slug = slugForBranch(dive, effort);

	const { scopes, failures } = uniqueDiveWipScopes(dive.scopes);
	if (failures.length > 0) {
		throw new Error(`land refuses: ${failures.map((f) => f.reasons.join("; ")).join(" | ")}`);
	}

	const pushed: string[] = [];
	const hydratedWorktrees: { repoId: string; path: string }[] = [];
	const writableScopes: { scope: (typeof scopes)[number]; path: string; repo: KbDoc }[] = [];
	for (const scope of scopes) {
		if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");
		const { path, failure } = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (failure) throw new Error(`land refuses: ${failure.reasons.join("; ")}`);
		if (!path) continue; // scope never hydrated -- nothing to land for this repo
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
		const repo = maybeResolveRepoDoc(kbDocs, scope.repoId);
		if (!repo) throw new Error(`land refuses: scoped repo ${scope.repoId} has no kb repo doc`);
		writableScopes.push({ scope, path, repo });
	}

	for (const { scope, path, repo } of writableScopes) {
		runRepoCheck(repo, path);
		const branch = branchForRepo(repo, slug, rc.workBranchPrefix ?? "work/");
		landRepoScope(path, branch);
		pushed.push(`${scope.repoId} -> ${branch}`);
		hydratedWorktrees.push({ repoId: scope.repoId, path });
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

	commitAndPushLand(rc.bridgeDir, dive.path, dive.name);

	// Marker cleared before dehydrate: the dive is already closed (kind: memo,
	// pushed) at this point, so a dehydrate failure must not leave the marker
	// pointing at a dive that can no longer be jumped/packed/bailed.
	const markerPath = join(rc.workspaceDir!, ".nosedive-ref");
	if (existsSync(markerPath)) unlinkSync(markerPath);

	for (const { repoId, path } of hydratedWorktrees) {
		removeHydratedWorktree(repoId, path, true);
	}

	io.log(`landed "${dive.gist}"`);
	io.log(outcome);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(land, args);
}
