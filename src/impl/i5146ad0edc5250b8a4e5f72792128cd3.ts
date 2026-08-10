import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { commitMessage } from "../lib/commitProvenance.js";
import { NO_ACTIVE_DIVE_ERROR_ID } from "../lib/constants.js";
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
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { appendTimestampedSection } from "../lib/kbSections.js";
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";
import { resolveEffortDoc } from "../lib/repoEffortScopes.js";
import { ensureManagedRepoCache, gitRun } from "../lib/repoWorkspaceCore.js";
import { resetHydratedWorktree, resolveRefCommit } from "../lib/repoWorktrees.js";

const BAIL_SECTION_LABEL = "Bail report";

/** Mirrors packDive's stash-except-staged: never `-u`, workspace repo checkouts
 * are untracked nested `.git` dirs that don't round-trip through stash/pop. */
function stashExceptStaged(bridgeDir: string): boolean {
	const before = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	gitRun(
		bridgeDir,
		["stash", "push", "--keep-index", "-m", "nosedive bail: temporary stash"],
		"failed to stash bridge state before bail push",
	);
	const after = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	return before !== after;
}

function commitAndPushBail(
	bridgeDir: string,
	divePath: string,
	diveName: string,
	reason: string,
	effortId?: string,
): void {
	const relPath = toPosixPath(relative(bridgeDir, divePath));
	gitRun(bridgeDir, ["add", "--", relPath], "failed to stage bailed dive");

	const stashed = stashExceptStaged(bridgeDir);
	try {
		const upstream = gitOutput(bridgeDir, [
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{upstream}",
		]);
		if (!upstream)
			throw new Error("bridge has no upstream to push to; configure one before bailing");
		const [remote] = upstream.split("/");
		gitRun(bridgeDir, ["fetch", remote!], "failed to fetch bridge remote before bail push");
		gitRun(
			bridgeDir,
			["merge", "--ff-only", upstream],
			"failed to fast-forward bridge before bail push; resolve manually and retry",
		);
		gitRun(
			bridgeDir,
			["commit", "-m", commitMessage(`bail(${diveName}): ${reason}`, effortId)],
			"failed to commit bailed dive",
		);
		gitRun(
			bridgeDir,
			["push"],
			"failed to push bridge after bail; dive is committed locally as a memo",
		);
	} finally {
		if (stashed)
			gitRun(bridgeDir, ["stash", "pop"], "failed to restore stashed bridge state after bail push");
	}
}

/** The reason is the one thing only the pilot knows, so it is a required flag:
 * a flag with a value cannot be typed by accident, and no default can stand in
 * for it. Parsed and enforced before any read or write, so a refusal changes
 * nothing. */
function parseBailArgs(args: string[]): string {
	let reason: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--reason") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("--"))
				throw new Error("bail --reason requires a value");
			reason = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--reason=")) {
			reason = arg.slice("--reason=".length);
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown bail option: ${arg}`);
		throw new Error(`unexpected bail argument: ${arg}; pass the reason as --reason "<why>"`);
	}
	if (reason === undefined) throw new Error('bail requires --reason "<why>"');
	const trimmed = reason.trim();
	if (!trimmed) throw new Error("bail reason cannot be empty");
	return trimmed;
}

/** One scope's worth of the bail report. A bail is cleaning up a workspace it
 * cannot trust, so every git question here is allowed to come back empty: a
 * scope that is missing, unhydrated or unreadable is recorded as such rather
 * than thrown on. */
function bailScopeLines(
	scope: DiveWipScope,
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string | undefined,
): string {
	const repoDoc = kbDocs.find((doc) => doc.id === scope.repoId);
	const name = repoDoc?.name ?? scope.repoId;
	const declaredPath = repoDoc?.repoPath ?? repoDoc?.metaScalars["worktree-path"] ?? "(unknown)";
	const pin = scope.ref ?? "(unpinned)";
	const head = `- repo=${name} id=${scope.repoId} path=${declaredPath} pin=${pin}`;

	if (!workspaceDir) return `${head}\n  - no workspace configured; worktree state not read`;
	const resolved = hydratedScopedRepoPath(kbDocs, scope, bridgeDir, workspaceDir);
	if (resolved.failure)
		return `${head}\n  - worktree not readable: ${resolved.failure.reasons.join("; ")}`;
	if (!resolved.path) return `${head}\n  - no worktree on disk; nothing to record`;

	const repoDir = resolved.path;
	const headSha = gitOutput(repoDir, ["rev-parse", "HEAD"]);
	const lines = [`${head} head=${headSha ?? "(unreadable)"}`];

	if (!headSha) {
		lines.push("  - worktree HEAD could not be read; commits above the pin are unknown");
	} else if (!scope.ref) {
		lines.push("  - scope has no pinned ref; commits above the pin cannot be listed");
	} else if (headSha === scope.ref) {
		lines.push("  - held no commits above its pin");
	} else {
		const log = gitOutput(repoDir, ["log", "--oneline", "--reverse", `${scope.ref}..${headSha}`]);
		if (log === undefined) {
			lines.push(`  - could not list commits between ${scope.ref} and ${headSha}`);
		} else if (!log.trim()) {
			lines.push("  - held no commits above its pin");
		} else {
			lines.push("  - orphaned commits, oldest first (`git checkout <sha>` restores them):");
			for (const entry of log.split("\n")) {
				if (entry.trim()) lines.push(`    - ${entry.trim()}`);
			}
		}
	}

	const status = gitOutput(repoDir, ["status", "--porcelain"]);
	if (status === undefined) lines.push("  - worktree status could not be read");
	else if (status.trim())
		lines.push("  - worktree was dirty; the uncommitted work is not recoverable");

	return lines.join("\n");
}

/** Written before the frontmatter rewrite and left uncommitted, so the existing
 * `git add` of the dive doc carries it in the same bridge commit as the memo
 * conversion. It is the only artifact of the dive that survives the bail. */
function appendBailReport(
	divePath: string,
	dive: KbDoc,
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string | undefined,
	reason: string,
): void {
	const { scopes, failures } = uniqueDiveWipScopes(dive.scopes);
	const parts = [`Bailed. Reason: ${reason}`, ""];
	if (scopes.length === 0 && failures.length === 0) parts.push("- no scoped repos");
	for (const scope of scopes) parts.push(bailScopeLines(scope, kbDocs, bridgeDir, workspaceDir));
	for (const failure of failures)
		parts.push(
			`- repo=${failure.repoId ?? "(unknown)"} unreadable scope: ${failure.reasons.join("; ")}`,
		);
	appendTimestampedSection(divePath, parts.join("\n"), BAIL_SECTION_LABEL);
}

/** A bailed dive is over, so the workspace should stop looking like one is in
 * flight: every scope goes back to its repo's trunk -- not to the dive's pin,
 * which is only a fact about the abandoned dive. Trunk is resolved exactly as
 * `record.dive` resolves it, off the managed cache.
 *
 * Reset in place, never force-remove: a re-hydrate is expensive, a locked file
 * makes removal fail outright, and VS Code drops the repo from its git tracker.
 *
 * Runs only after the bail is committed and pushed, and after the report
 * section has recorded the shas this is about to orphan. Nothing here may
 * throw: the memo is already on the remote, so a scope that cannot be reset is
 * a warning naming the repo and the path, not a failed bail. */
function resetScopesToTrunk(
	dive: KbDoc,
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string | undefined,
	io: CommandIo,
): void {
	const { scopes } = uniqueDiveWipScopes(dive.scopes);
	for (const scope of scopes) {
		const repoDoc = kbDocs.find((doc) => doc.id === scope.repoId);
		const name = repoDoc?.name ?? scope.repoId;
		const declaredPath = repoDoc?.repoPath ?? repoDoc?.metaScalars["worktree-path"] ?? "(unknown)";
		if (!workspaceDir) {
			io.err(`warning: repo=${name} path=${declaredPath} not reset: no workspace configured`);
			continue;
		}
		if (!repoDoc) {
			io.err(`warning: repo=${name} path=${declaredPath} not reset: repo doc not found in kb`);
			continue;
		}
		const resolved = hydratedScopedRepoPath(kbDocs, scope, bridgeDir, workspaceDir);
		if (resolved.failure) {
			io.err(
				`warning: repo=${name} path=${declaredPath} not reset: ${resolved.failure.reasons.join("; ")}`,
			);
			continue;
		}
		if (!resolved.path) {
			io.err(`warning: repo=${name} path=${declaredPath} not reset: no worktree on disk`);
			continue;
		}
		const repoDir = resolved.path;
		try {
			const trunk = repoDoc.repoBaseBranch ?? "main";
			const commit = resolveRefCommit(
				ensureManagedRepoCache(repoDoc, bridgeDir),
				repoDoc.id,
				trunk,
			);
			resetHydratedWorktree(scope.repoId, repoDir, commit);
			io.log(`reset repo=${name} path=${formatPath(repoDir)} trunk=${trunk} commit=${commit}`);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			io.err(`warning: repo=${name} path=${formatPath(repoDir)} not reset: ${detail}`);
		}
	}
}

function bail(args: string[], io: CommandIo): void {
	const reason = parseBailArgs(args);
	const rc = readNosediveRc(process.cwd());

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) throw new Error(NO_ACTIVE_DIVE_ERROR_ID);
	if (marker.error || !marker.id)
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);

	if (!rc.kbDir) throw new Error("bail requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.id === marker.id);
	if (!dive) throw new Error(`active dive ${marker.id} not found in kb`);

	const markerPath = join(rc.workspaceDir!, ".nosedive-ref");
	const relDivePath = relative(rc.bridgeDir, dive.path);
	const status = gitOutput(rc.bridgeDir, ["status", "--porcelain", "--", relDivePath]) ?? "";

	if (status.startsWith("??")) {
		unlinkSync(dive.path);
		if (existsSync(markerPath)) unlinkSync(markerPath);
		io.log(`bailed "${dive.gist}" (never committed) -- deleted ${formatPath(dive.path)}`);
		return;
	}

	appendBailReport(dive.path, dive, kbDocs, rc.bridgeDir, rc.workspaceDir, reason);

	const text = readFileSync(dive.path, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(dive.path));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in frontmatter in ${formatPath(dive.path)}`);

	doc.set("kind", "memo");
	doc.set("gist", `${dive.gist} -- bailed: ${reason}`);

	writeFileAtomic(dive.path, ["---", stringifyYaml(doc).trimEnd(), "---", parsed.body].join("\n"));

	commitAndPushBail(
		rc.bridgeDir,
		dive.path,
		dive.name,
		reason,
		dive.effortRef ? resolveEffortDoc(kbDocs, rc, dive.effortRef).id : undefined,
	);
	if (existsSync(markerPath)) unlinkSync(markerPath);
	io.log(`bailed "${dive.gist}" -- converted to memo, reason: ${reason}`);
	resetScopesToTrunk(dive, kbDocs, rc.bridgeDir, rc.workspaceDir, io);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(bail, args);
}
