import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isSeq, parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { commitMessage } from "../lib/commitProvenance.js";
import {
	DIVE_BRIEF_HEADING,
	DIVE_BRIEF_HEADING_PATTERN,
	NO_ACTIVE_DIVE_ERROR_ID,
} from "../lib/constants.js";
import {
	formatPath,
	isInsideDir,
	parseMarkdownDoc,
	readNosediveRc,
	resolveFrom,
	splitMarkdownFrontmatter,
	stringifyYaml,
	toPosixPath,
} from "../lib/coreParsing.js";
import { DiveWipScope, readWorkspaceDiveMarker, uniqueDiveWipScopes } from "../lib/gitState.js";
import { recreateDiveScratch, renderDiveScratchHandoff } from "../lib/diveScratch.js";
import { appendTimestampedSection } from "../lib/kbSections.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { unsafeLinkPath } from "../lib/proveCore.js";
import { reconcileDiveEffortLinks, resolveEffortDoc } from "../lib/repoEffortScopes.js";
import { gitOutput, runGit } from "../lib/gitProcess.js";
import { writeFileAtomic } from "../lib/renderPlan.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	gitRun,
	maybeResolveRepoDoc,
} from "../lib/repoWorkspaceCore.js";
import {
	ensureDetachedAtCommit,
	ensureRepoMarkerExcluded,
	writeRepoMarker,
} from "../lib/repoWorktrees.js";
import { reconcilePrepareCommitMsgHook, reconcilePushIsolation } from "../lib/repoHardening.js";
import { hydrateScopeAtPin as hydrateScopeCore } from "../lib/scopeHydration.js";

/** One patch memo in reapply order, walked from a dive's `rel: patch` head via `rel: next`. */
interface PatchStep {
	memoPath: string;
	patchAbsPath: string;
	name: string;
	/** `<sha12>.<slug>` memos are real commits (git am); `dirty.*` / `bridge-wip.*` are working-tree diffs (git apply). */
	isCommit: boolean;
}

function hydrateScopeAtPin(
	scope: DiveWipScope,
	kbDocs: KbDoc[],
	bridgeDir: string,
	workspaceDir: string,
	effortId: string,
): string {
	const result = hydrateScopeCore(scope, kbDocs, bridgeDir, workspaceDir);
	const { repoDoc, sourcePath, targetPath, commit } = result;
	if (!result.created) {
		/**
		 * Only force back to the pin when the target isn't already sitting on
		 * top of it. A prior jump run may have already reapplied (and then
		 * deleted) this scope's chain, leaving HEAD legitimately ahead of the
		 * pin with nothing left to apply -- forcing it back to the pin on every
		 * re-run would silently discard that progress.
		 */
		const pinIsAncestorOfHead =
			runGit(targetPath, ["merge-base", "--is-ancestor", commit, "HEAD"]).status === 0;
		if (!pinIsAncestorOfHead) {
			ensureDetachedAtCommit(targetPath, commit, scope.repoId);
		}
	}
	writeRepoMarker(targetPath, scope.repoId);
	ensureRepoMarkerExcluded(targetPath, scope.repoId);

	/**
	 * Also enables `extensions.worktreeConfig` and the per-worktree
	 * `core.bare=false` a linked worktree off a bare-cloned cache needs --
	 * without both, git treats the worktree as bare and every non-log command
	 * in it fails with "this operation must be run in a work tree".
	 */
	reconcilePushIsolation(sourcePath, targetPath, scope.readOnly, scope.repoId);
	reconcilePrepareCommitMsgHook(targetPath, effortId, repoDoc);

	return targetPath;
}

function linkDocId(target: string): string {
	const match = /^kb\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i.exec(
		target,
	);
	return match ? match[1]!.toLowerCase() : target;
}

function walkPatchChain(kbDocs: KbDoc[], bridgeDir: string, headId: string): PatchStep[] {
	const steps: PatchStep[] = [];
	let currentId: string | undefined = headId;
	const seen = new Set<string>();
	while (currentId) {
		if (seen.has(currentId)) throw new Error(`patch chain cycle detected at ${currentId}`);
		seen.add(currentId);

		const memo = kbDocs.find((doc) => doc.id === currentId);
		if (!memo) throw new Error(`patch chain memo not found: ${currentId}`);
		const patchRel = memo.metaScalars.patch;
		if (!patchRel) throw new Error(`patch memo ${memo.relPath} is missing meta.patch`);
		// pack always writes kb/artifacts/<id>.patch; reject anything else so a
		// crafted meta.patch (absolute path, ../ traversal) can't point jump's
		// git am / unlink at files outside the bridge.
		if (unsafeLinkPath(patchRel) || isAbsolute(patchRel) || !patchRel.startsWith("kb/artifacts/")) {
			throw new Error(`patch memo ${memo.relPath} has an unsafe meta.patch: ${patchRel}`);
		}
		const patchAbsPath = resolveFrom(bridgeDir, patchRel);
		if (!isInsideDir(join(bridgeDir, "kb/artifacts"), patchAbsPath)) {
			throw new Error(
				`patch memo ${memo.relPath} meta.patch resolves outside kb/artifacts: ${patchRel}`,
			);
		}

		steps.push({
			memoPath: memo.path,
			patchAbsPath,
			name: memo.name,
			isCommit: /^[0-9a-f]{12}\./.test(memo.name),
		});

		const next = memo.links.find((link) => link.rel === "next");
		currentId = next?.id;
	}
	return steps;
}

/** `bridge-wip.*` chains apply straight onto the bridge; everything else matches a scoped repo by its kb doc `name`. */
function resolveChainTarget(
	headName: string,
	scopes: DiveWipScope[],
	kbDocs: KbDoc[],
	bridgeDir: string,
	scopePaths: Map<string, string>,
): { path: string; label: string } {
	if (headName.startsWith("bridge-wip.")) return { path: bridgeDir, label: "bridge kb/" };

	const slug = headName.slice(headName.indexOf(".") + 1);
	for (const scope of scopes) {
		const repoDoc = maybeResolveRepoDoc(kbDocs, scope.repoId);
		if (repoDoc?.name !== slug) continue;
		const path = scopePaths.get(scope.repoId);
		if (!path) throw new Error(`scope ${scope.repoId} was not hydrated`);
		return { path, label: `repo ${scope.repoId}` };
	}
	throw new Error(`patch chain head '${headName}' matches no scoped repo or bridge-wip`);
}

function updateDiveDocAfterJump(divePath: string, appliedHeadIds: Set<string>): void {
	const text = readFileSync(divePath, "utf8");
	const block = splitMarkdownFrontmatter(text, formatPath(divePath));
	const doc = parseDocument(block.yaml);
	if (doc.errors.length > 0) {
		throw new Error(`invalid YAML in frontmatter in ${formatPath(divePath)}`);
	}

	const links = doc.get("links");
	if (isSeq(links)) {
		const kept = (links.toJSON() as unknown[]).filter((entry) => {
			const key = typeof entry === "string" ? entry : Object.keys(entry as object)[0];
			return !(key && appliedHeadIds.has(linkDocId(key)));
		});
		if (kept.length > 0) doc.set("links", kept);
		else doc.delete("links");
	}

	writeFileAtomic(divePath, `---\n${stringifyYaml(doc).trimEnd()}\n---\n${block.body}`);
}

function stashExceptStaged(bridgeDir: string): boolean {
	const before = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	gitRun(
		bridgeDir,
		["stash", "push", "--keep-index", "-m", "nosedive jump: temporary stash"],
		"failed to stash bridge state before jump push",
	);
	const after = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	return before !== after;
}

function commitAndPushJump(
	bridgeDir: string,
	divePath: string,
	otherAbsPaths: string[],
	message: string,
	effortId?: string,
): void {
	const pathsToStage = [divePath, ...otherAbsPaths].map((path) =>
		toPosixPath(relative(bridgeDir, path)),
	);
	gitRun(bridgeDir, ["add", "--", ...pathsToStage], "failed to stage jump dive update");

	// A re-run with nothing left to apply can still land here (the dive doc's
	// `diver` line gets rewritten to the same value it already had) -- if
	// staging produced no actual diff, there is nothing to commit or push.
	if (runGit(bridgeDir, ["diff", "--cached", "--quiet"]).status === 0) return;

	const stashed = stashExceptStaged(bridgeDir);
	try {
		const upstream = gitOutput(bridgeDir, [
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{upstream}",
		]);
		if (!upstream)
			throw new Error("bridge has no upstream to push to; configure one before jumping");
		const [remote] = upstream.split("/");
		gitRun(bridgeDir, ["fetch", remote!], "failed to fetch bridge remote before jump push");
		gitRun(
			bridgeDir,
			["merge", "--ff-only", upstream],
			"failed to fast-forward bridge before jump push; resolve manually and retry",
		);
		gitRun(
			bridgeDir,
			["commit", "-m", commitMessage(message, effortId)],
			"failed to commit jumped dive",
		);
		gitRun(bridgeDir, ["push"], "failed to push bridge after jump; dive is committed locally");
	} finally {
		if (stashed) {
			gitRun(bridgeDir, ["stash", "pop"], "failed to restore stashed bridge state after jump push");
		}
	}
}

/**
 * `pack` captures each patch via `gitRun`, which trims stdout -- stripping
 * the trailing newline `format-patch`/`diff` output always ends with, which
 * `git am`/`git apply` both require. Repairs it in place before applying.
 */
function ensureTrailingNewline(path: string): void {
	const text = readFileSync(path, "utf8");
	if (text.length > 0 && !text.endsWith("\n")) {
		writeFileAtomic(path, `${text}\n`);
	}
}

function applyPatchStep(step: PatchStep, targetPath: string, label: string): void {
	ensureTrailingNewline(step.patchAbsPath);
	if (step.isCommit) {
		gitRun(targetPath, ["am", step.patchAbsPath], `failed to apply commit patch for ${label}`);
	} else {
		gitRun(
			targetPath,
			["apply", "--binary", step.patchAbsPath],
			`failed to apply working-tree patch for ${label}`,
		);
	}
}

/**
 * `jump`'s last word is a handoff: the agent reading this has the workspace but
 * none of the reasoning behind it. Paths are relative to the cwd `jump` ran in
 * so a plain read tool takes them verbatim.
 */
function printWorkDirective(
	dive: KbDoc,
	effort: KbDoc | undefined,
	bridgeDir: string,
	workspaceDir: string,
	io: CommandIo,
): void {
	const divePath = toPosixPath(relative(process.cwd(), dive.path));
	io.log("");
	io.log(
		`Read the dive at ${divePath} in full -- its "${DIVE_BRIEF_HEADING}" section is your brief, ` +
			`and any notes below it are what earlier divers did and left undone.`,
	);
	if (effort) {
		io.log(
			`Read the effort it serves at ${toPosixPath(relative(process.cwd(), effort.path))}, ` +
				`and whatever those two link to in their frontmatter.`,
		);
	}
	io.log(
		`Then do the work, to the endpoint the brief names -- not more. ` +
			`Commit completed work in every writable scoped repo. ` +
			`Append a timestamped section to the dive summary saying what you did, each resulting commit SHA, and what you think is next. ` +
			`Do not edit the brief or change any scope pin. ` +
			`Never push an implementation repo: only land may push to implementation remotes.`,
	);
	io.log(renderDiveScratchHandoff(bridgeDir, workspaceDir, dive.id));
}

/**
 * Mechanical record of what jump hydrated and where, appended to the dive so
 * "has this dive ever been jumped" is readable off its absence -- one line
 * per scoped repo, by kb `name` rather than uuid, same reasoning as
 * `land`'s gate-context repo keys.
 */
function renderHydratedSection(
	entries: { scope: DiveWipScope; path: string }[],
	kbDocs: KbDoc[],
): string {
	return entries
		.map(({ scope, path }) => {
			const repoDoc = kbDocs.find((doc) => doc.id === scope.repoId);
			const name = repoDoc?.name ?? scope.repoId;
			const mode = scope.readOnly ? "ro" : "rw";
			return `- repo=${name} path=${formatPath(path)} mode=${mode} ref=${scope.ref}`;
		})
		.join("\n");
}

export function jump(args: string[], io: CommandIo): void {
	if (args.length > 0) throw new Error(`jump takes no arguments: ${args.join(" ")}`);

	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) throw new Error(NO_ACTIVE_DIVE_ERROR_ID);
	if (marker.error || !marker.id) {
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);
	}

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.kind === "dive" && doc.id === marker.id);
	if (!dive) throw new Error(`active dive marker names no kind: dive doc: ${marker.id}`);

	// Checked before anything is hydrated: an unbriefed dive has nothing to hand
	// the next agent, and jump's whole output is that handoff.
	const diveBody = parseMarkdownDoc(readFileSync(dive.path, "utf8"), formatPath(dive.path)).body;
	if (!DIVE_BRIEF_HEADING_PATTERN.test(diveBody)) {
		throw new Error(
			`dive ${dive.id} has no "${DIVE_BRIEF_HEADING}" section: ${formatPath(dive.path)}; ` +
				`brief it with \`record.dive --ref ${dive.id} --brief "<brief>"\` first`,
		);
	}

	const { scopes, failures } = uniqueDiveWipScopes(dive.scopes);
	if (failures.length > 0) {
		throw new Error(failures.flatMap((failure) => failure.reasons).join("; "));
	}
	// The parsed field, not the raw key: it accepts `meta.feat` and the older
	// `meta.effort` alike, and reading past it made a dive written the canonical
	// way impossible to jump at all.
	const effortRef = dive.effortRef;
	if (!effortRef) throw new Error(`dive ${dive.id} names no feat in meta.feat`);
	const effort = resolveEffortDoc(kbDocs, rc, effortRef);
	recreateDiveScratch(rc.workspaceDir, dive.id);

	const scopePaths = new Map<string, string>();
	const hydratedEntries: { scope: DiveWipScope; path: string }[] = [];
	for (const scope of scopes) {
		const path = hydrateScopeAtPin(scope, kbDocs, rc.bridgeDir, rc.workspaceDir, effort.id);
		scopePaths.set(scope.repoId, path);
		hydratedEntries.push({ scope, path });
		io.log(`hydrated repo=${scope.repoId} path=${formatPath(path)}`);
	}

	const patchHeadIds = dive.links.filter((link) => link.rel === "patch").map((link) => link.id);
	const appliedHeadIds = new Set<string>();
	const appliedFileAbsPaths: string[] = [];
	let appliedCount = 0;
	let failedChains = 0;

	for (const headId of patchHeadIds) {
		const steps = walkPatchChain(kbDocs, rc.bridgeDir, headId);
		const target = resolveChainTarget(steps[0]!.name, scopes, kbDocs, rc.bridgeDir, scopePaths);
		// Collected locally and only merged in on full success -- a chain that
		// fails partway must leave every one of its memos/patches in place, or
		// the dive's still-present `rel: patch` link would point at a deleted
		// memo on retry.
		const chainFileAbsPaths: string[] = [];
		try {
			for (const step of steps) {
				applyPatchStep(step, target.path, target.label);
				chainFileAbsPaths.push(step.memoPath, step.patchAbsPath);
			}
			appliedHeadIds.add(headId);
			appliedFileAbsPaths.push(...chainFileAbsPaths);
			appliedCount += steps.length;
		} catch (err) {
			failedChains += 1;
			const detail = err instanceof Error ? err.message : String(err);
			io.err(
				`failed to apply patch chain ${headId} onto ${target.label}: ${detail}; left un-applied on the dive for retry`,
			);
			// Best-effort: a failed `git am` step leaves the target mid-rebase; an
			// already-committed prefix of the chain is left in place (git am is
			// resumable), only the interrupted state is cleared.
			runGit(target.path, ["am", "--abort"]);
		}
	}

	updateDiveDocAfterJump(dive.path, appliedHeadIds);
	for (const path of appliedFileAbsPaths) {
		if (existsSync(path)) unlinkSync(path);
	}

	appendTimestampedSection(dive.path, renderHydratedSection(hydratedEntries, kbDocs));
	reconcileDiveEffortLinks(effort, effort, dive.id, "jumped.dive");

	// The effort's reciprocal link records that this command jumped the dive, so
	// it is part of the same bookkeeping -- left unstaged it lingers as bridge
	// WIP that the next pack captures as though it were work.
	commitAndPushJump(
		rc.bridgeDir,
		dive.path,
		[...appliedFileAbsPaths, effort.path],
		`jump(${dive.name}): unpacked work`,
		effort.id,
	);

	writeFileAtomic(join(rc.workspaceDir, ".nosedive-ref"), `id: ${dive.id}\n`);

	io.log(
		appliedCount > 0
			? `jumped dive ${dive.id}: applied ${appliedCount} artifact(s)`
			: `jumped dive ${dive.id}: nothing to unpack`,
	);
	if (failedChains > 0) {
		io.err(`${failedChains} patch chain(s) failed to apply; see above`);
		io.setExitCode(1);
		return;
	}

	printWorkDirective(dive, effort, rc.bridgeDir, rc.workspaceDir, io);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(jump, args);
}
