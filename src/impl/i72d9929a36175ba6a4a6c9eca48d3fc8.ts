import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isSeq, parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { commitMessage } from "../lib/commitProvenance.js";
import { DIVE_BRIEF_HEADING, DIVE_BRIEF_HEADING_PATTERN } from "../lib/constants.js";
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
import { DiveWipScope, uniqueDiveWipScopes } from "../lib/gitState.js";
import { recreateDiveScratch, renderDiveScratchHandoff } from "../lib/diveScratch.js";
import { appendTimestampedSection, latestLoggedSection } from "../lib/kbSections.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { claimAndLabel, parseJumpArgs, selectJumpDive } from "../lib/jumpSelect.js";
import { unsafeLinkPath } from "../lib/proveCore.js";
import { reconcileDiveFeatLinks, resolveFeatDoc } from "../lib/repoFeatScopes.js";
import { gitOutput, runGit } from "../lib/gitProcess.js";
import { nosediveInvocation } from "../lib/packageBacklog.js";
import { writeFileAtomic } from "../lib/renderPlan.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	gitRun,
	maybeResolveRepoDoc,
} from "../lib/repoWorkspaceCore.js";
import { ensureRepoMarkerExcluded, writeRepoMarker } from "../lib/repoWorktrees.js";
import { reconcilePrepareCommitMsgHook, reconcilePushIsolation } from "../lib/repoHardening.js";
import {
	hydrateScopeAtPin as hydrateScopeCore,
	moveScopeToPin,
	pinBehindTrunk,
	refuseUnmovableScopes,
	type HydratedScope,
	type StalePin,
} from "../lib/scopeHydration.js";

/** One patch memo in reapply order, walked from a dive's `rel: patch` head via `rel: next`. */
interface PatchStep {
	memoPath: string;
	patchAbsPath: string;
	name: string;
	/** `<sha12>.<slug>` memos are real commits (git am); `dirty.*` / `bridge-wip.*` are working-tree diffs (git apply). */
	isCommit: boolean;
}

const JUMP_LOG_FRESH_MS = 4 * 60 * 60 * 1000;

/**
 * Everything a scope needs after the reuse policy has cleared the whole set:
 * the move onto the pin, the marker, and the worktree-local config an agent
 * commits through.
 */
function settleScope(
	hydrated: HydratedScope,
	scope: DiveWipScope,
	featId: string,
	diveId: string,
): { targetPath: string; stale?: StalePin; repoName: string; movedFrom?: string } {
	const { repoDoc, sourcePath, targetPath, commit } = hydrated;
	const movedFrom = moveScopeToPin(hydrated);
	writeRepoMarker(targetPath, scope.repoId);
	ensureRepoMarkerExcluded(targetPath, scope.repoId);

	/**
	 * Also enables `extensions.worktreeConfig` and the per-worktree
	 * `core.bare=false` a linked worktree off a bare-cloned cache needs --
	 * without both, git treats the worktree as bare and every non-log command
	 * in it fails with "this operation must be run in a work tree".
	 */
	reconcilePushIsolation(sourcePath, targetPath, scope.readOnly, scope.repoId);
	reconcilePrepareCommitMsgHook(targetPath, featId, diveId, repoDoc);

	return {
		targetPath,
		movedFrom,
		repoName: repoDoc.name || scope.repoId,
		stale: pinBehindTrunk(sourcePath, commit, repoDoc.repoBaseBranch ?? "main"),
	};
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
	featId?: string,
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
			["commit", "-m", commitMessage(message, featId)],
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
	feat: KbDoc | undefined,
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
	if (feat) {
		io.log(
			`Read the feat it serves at ${toPosixPath(relative(process.cwd(), feat.path))}, ` +
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
 * What jump did, appended to the dive: a lead line saying the dive was picked
 * up and by whom, then the mechanical record of what was hydrated and where --
 * one line per scoped repo, by kb `name` rather than uuid, same reasoning as
 * `land`'s gate-context repo keys.
 *
 * The lead line is there because the mechanical lines alone name paths and
 * shas and never say what event produced them. It carries the scope count for
 * the same reason: a dive that scopes no repo and a run whose repos all
 * dropped out otherwise render identically, as a heading over nothing.
 *
 * `ref=` is the commit hydration resolved, not the scope's `ref:` string. A
 * `ref:` may name a branch, and a branch moves -- a section recording the name
 * records nothing a reader can go back to.
 */
function renderJumpedSection(
	who: string,
	featName: string,
	entries: { scope: DiveWipScope; path: string; commit: string }[],
	kbDocs: KbDoc[],
): string {
	const lead = `${who} picked up ${featName}, hydrating ${entries.length} scoped repo${
		entries.length === 1 ? "" : "s"
	}.`;
	const lines = entries
		.map(({ scope, path, commit }) => {
			const repoDoc = kbDocs.find((doc) => doc.id === scope.repoId);
			const name = repoDoc?.name ?? scope.repoId;
			// No `mode=`: it named a concept that no longer exists. A scope says
			// where its work goes by naming a branch, so the line carries the branch
			// when there is one and says nothing when there is not -- the same shape
			// the scope entry itself has.
			const branch = scope.workBranch ? ` work-branch=${scope.workBranch}` : "";
			return `- repo=${name} path=${formatPath(path)}${branch} ref=${commit}`;
		})
		.join("\n");
	return lines ? `${lead}\n\n${lines}` : lead;
}

/**
 * What the run did, worth one commit subject, or nothing when it did nothing.
 *
 * Ordered most concrete first, and only the winner is named: a jump that
 * unpacked artifacts also picked the dive up, and saying so twice tells the
 * reader nothing the dive's own `## Jumped` section does not.
 *
 * `picked up` outranks `claimed` because a first jump always claims -- claiming
 * is what picking up means. `claimed` is left to name what it uniquely is: a
 * dive somebody had already jumped, released by a `pack`, and now picked back up.
 */
function jumpSubject(
	appliedCount: number,
	alreadyJumped: boolean,
	claimed: boolean,
	hasRecentLog: boolean,
): string | undefined {
	if (appliedCount > 0) {
		return `unpacked ${appliedCount} artifact${appliedCount === 1 ? "" : "s"}`;
	}
	if (!alreadyJumped) return "picked up";
	if (claimed) return "claimed";
	if (!hasRecentLog) return "resumed";
	return undefined;
}

export function jump(args: string[], io: CommandIo): void {
	const ref = parseJumpArgs(args);

	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	// A refusal here is already on stderr with the exit code set: what it has to
	// say is a list of the dives that could be jumped instead, which reads far
	// better unprefixed than folded into a single thrown error line.
	const selection = selectJumpDive(rc, kbDocs, ref, io);
	if (!selection) return;
	const dive = selection.dive;

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
	const featRef = dive.featRef;
	if (!featRef) throw new Error(`dive ${dive.id} names no feat in meta.feat`);
	const feat = resolveFeatDoc(kbDocs, rc, featRef);
	recreateDiveScratch(rc.workspaceDir, dive.id);

	const scopePaths = new Map<string, string>();
	const hydratedEntries: { scope: DiveWipScope; path: string; commit: string }[] = [];
	// Two passes on purpose. A refusal that has already relocated three of five
	// worktrees is not a refusal, so every scope is resolved and judged before
	// any of them is moved, and every offender is named in the one message.
	const resolved: { scope: DiveWipScope; hydrated: HydratedScope }[] = [];
	for (const scope of scopes) {
		const hydrated = hydrateScopeCore(scope, kbDocs, rc.bridgeDir, rc.workspaceDir);
		resolved.push({ scope, hydrated });
	}
	refuseUnmovableScopes(
		resolved.map((entry) => entry.hydrated),
		`${nosediveInvocation()} record.dive --ref ${dive.id} --repin`,
	);
	for (const { scope, hydrated } of resolved) {
		const settled = settleScope(hydrated, scope, feat.id, dive.id);
		const path = settled.targetPath;
		scopePaths.set(scope.repoId, path);
		hydratedEntries.push({ scope, path, commit: hydrated.commit });
		io.log(
			`hydrated repo=${scope.repoId} path=${formatPath(path)}` +
				(settled.movedFrom ? ` moved-from=${settled.movedFrom}` : ""),
		);
		// A warning, not a refusal: a planned dive that merely waited is the
		// ordinary case. The agent picking it up was not there when the pin was
		// chosen and has no reason to suspect it, so say how far behind and name
		// the fix -- a warning nobody can act on only teaches people to skip them.
		if (settled.stale) {
			io.err(
				`jump: ${settled.repoName} is pinned ${settled.stale.behind} commit${
					settled.stale.behind === 1 ? "" : "s"
				} behind ${settled.stale.trunk}; re-pin with \`${nosediveInvocation()} record.dive --ref ${dive.id} --repin\``,
			);
		}
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

	// `meta.diver` is the recorded holder and so the honest answer to whose dive
	// this is; a run that claimed the dive writes that holder here, and the name
	// beside it is display only -- see `claimAndLabel`.
	const diver = claimAndLabel(rc, dive, selection);
	const alreadyJumped = feat.links.some(
		(link) => link.id === dive.id && link.rel === "jumped.dive",
	);
	const latestLog = latestLoggedSection(readFileSync(dive.path, "utf8"));
	const hasRecentLog = latestLog !== undefined && Date.now() - latestLog.at <= JUMP_LOG_FRESH_MS;
	// A recent re-hydration of the same pilot's already-jumped dive is the one
	// true no-op. Claims, phase transitions, stale/missing logs, and applied
	// patches are events worth committing even when hydration itself moved no ref.
	//
	// A failed chain is not one of them. The run has left the dive half-unpacked
	// -- some links stripped, some artifacts deleted -- and nothing about that
	// half-state is worth its own commit; the retry that finally applies the rest
	// commits the whole thing under one honest subject.
	const subject = jumpSubject(appliedCount, alreadyJumped, selection.claim, hasRecentLog);
	if (failedChains === 0 && subject) {
		appendTimestampedSection(
			dive.path,
			renderJumpedSection(diver, feat.name || feat.id, hydratedEntries, kbDocs),
			"Jumped",
		);
		reconcileDiveFeatLinks(feat, feat, dive.id, "jumped.dive");

		// The feat's reciprocal link records that this command jumped the dive, so
		// it is part of the same bookkeeping -- left unstaged it lingers as bridge
		// WIP that the next pack captures as though it were work.
		commitAndPushJump(
			rc.bridgeDir,
			dive.path,
			[...appliedFileAbsPaths, feat.path],
			`jump(${dive.name}): ${subject}`,
			feat.id,
		);
	}

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

	printWorkDirective(dive, feat, rc.bridgeDir, rc.workspaceDir, io);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(jump, args);
}
