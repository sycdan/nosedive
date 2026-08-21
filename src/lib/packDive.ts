import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { isSeq, parseDocument } from "yaml";

import { CommandIo, createUuid7Minter } from "./bridgeSetupIo.js";
import { commitMessage } from "./commitProvenance.js";
import { NO_ACTIVE_DIVE_ERROR_ID } from "./constants.js";
import {
	formatPath,
	parseMarkdownDoc,
	readNosediveRc,
	stringifyYaml,
	toPosixPath,
} from "./coreParsing.js";
import {
	checkScopedRepoWip,
	DiveWipScope,
	hydratedScopedRepoPath,
	readWorkspaceDiveMarker,
	uniqueDiveWipScopes,
} from "./gitState.js";
import { KbDoc, loadKbDocs } from "./kbDocs.js";
import {
	CapturedPatch,
	captureDirtyPatch,
	gitRunPatch,
	listAheadCommits,
	writeArtifact,
} from "./packArtifacts.js";
import {
	assertDiveOwnsDirtyKb,
	dirtyKbEntries,
	excludedKbPaths,
	followLinkedKbPaths,
} from "./packKbWip.js";
import { reconcileDiveFeatLinks, releaseDiveToPacker, resolveFeatDoc } from "./repoFeatScopes.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import { gitRun } from "./repoWorkspaceCore.js";
import { resetHydratedWorktree } from "./repoWorktrees.js";

function packRepoScope(
	scope: DiveWipScope,
	repoPath: string,
	kbDir: string,
	mintUuid: () => string,
): CapturedPatch[] {
	if (!scope.ref) throw new Error(`scoped repo ${scope.repoId} has no pinned ref to pack against`);

	const entries: CapturedPatch[] = [];
	for (const sha of listAheadCommits(repoPath, scope.ref, scope.repoId)) {
		const patch = gitRunPatch(
			repoPath,
			["format-patch", "-1", sha, "--stdout", "--binary", "--no-signature"],
			`failed to format patch for repo ${scope.repoId} commit ${sha}`,
		);
		const commitMessage = gitRun(
			repoPath,
			["log", "-1", "--format=%B", sha],
			`failed to read commit message for repo ${scope.repoId} commit ${sha}`,
		);
		const id = mintUuid();
		const written = writeArtifact(kbDir, id, patch);
		entries.push({
			repoId: scope.repoId,
			patchRelPath: written.relPath,
			patchAbsPath: written.absPath,
			sha,
			commitMessage,
		});
	}

	const dirtyPatch = captureDirtyPatch(repoPath, scope.repoId);
	if (dirtyPatch !== undefined) {
		const id = mintUuid();
		const written = writeArtifact(kbDir, id, dirtyPatch);
		entries.push({
			repoId: scope.repoId,
			patchRelPath: written.relPath,
			patchAbsPath: written.absPath,
			dirty: true,
		});
	}

	return entries;
}

function packBridgeWip(
	bridgeDir: string,
	kbDir: string,
	excluded: Set<string>,
	linked: Set<string>,
	mintUuid: () => string,
): CapturedPatch | undefined {
	const dirtyKbFiles: string[] = [];
	const untracked: string[] = [];
	for (const entry of dirtyKbEntries(bridgeDir, kbDir)) {
		if (excluded.has(entry.path) || !linked.has(entry.path)) continue;
		dirtyKbFiles.push(entry.path);
		if (entry.statusCode === "??") untracked.push(entry.path);
	}
	if (dirtyKbFiles.length === 0) return undefined;

	if (untracked.length > 0) {
		gitRun(
			bridgeDir,
			["add", "--intent-to-add", "--", ...untracked],
			"failed to stage untracked bridge kb/ files for pack",
		);
	}
	let diff: string;
	try {
		diff = gitRunPatch(
			bridgeDir,
			["diff", "--binary", "HEAD", "--", ...dirtyKbFiles],
			"failed to capture bridge kb/ dirty diff for pack",
		);
	} finally {
		if (untracked.length > 0) {
			gitRun(
				bridgeDir,
				["reset", "--", ...untracked],
				"failed to unstage intent-to-add markers for bridge kb/ pack",
			);
		}
	}
	if (!diff.trim()) return undefined;

	const id = mintUuid();
	const written = writeArtifact(kbDir, id, diff);
	return { repoId: "", patchRelPath: written.relPath, patchAbsPath: written.absPath, dirty: true };
}

/**
 * Links are for docs: a dive should never link a raw `.patch` file directly.
 * Each captured patch gets its own `kind: memo` wrapping it -- gist is the
 * commit's first line (or a synthetic one for dirty/bridge-wip state), body
 * is the rest of the message, `meta.patch` points at the patch file, and
 * `links: rel: next` chains to the next memo in reapply order. The dive links
 * only the head of each chain (`rel: patch`); walking `next` from there is
 * unambiguous in a way a reorderable YAML array is not.
 */
function repoSlug(kbDocs: KbDoc[], repoId: string): string {
	return kbDocs.find((doc) => doc.id === repoId)?.name ?? repoId;
}

function renderPatchMemo(options: {
	id: string;
	name: string;
	gist: string;
	patchRelPath: string;
	body: string;
	nextMemoRelPath?: string;
}): string {
	const lines = [
		"---",
		"kind: memo",
		`id: ${options.id}`,
		`name: ${options.name}`,
		`gist: ${quoteYamlString(options.gist)}`,
		"meta:",
		`  patch: ${options.patchRelPath}`,
	];
	if (options.nextMemoRelPath) {
		lines.push("links:", `  - ${options.nextMemoRelPath}:`, "      rel: next");
	}
	lines.push("---", "", options.body.trim(), "");
	return lines.join("\n");
}

function patchMemoContent(
	patch: CapturedPatch,
	slug: string,
	memoId: string,
): { name: string; gist: string; body: string } {
	if (patch.sha) {
		const [subject, ...rest] = (patch.commitMessage ?? "").split(/\r?\n/);
		return {
			name: `${patch.sha.slice(0, 12)}.${slug}`,
			gist: subject?.trim() || "(no commit message)",
			body: rest.join("\n"),
		};
	}
	if (patch.repoId) {
		return {
			name: `dirty.${slug}`,
			gist: "Uncommitted working-tree changes.",
			body: "",
		};
	}
	return {
		name: `bridge-wip.${memoId.replaceAll("-", "").slice(-6)}`,
		gist: "Uncommitted bridge kb/ changes.",
		body: "",
	};
}

/** Mints one memo per patch, chained oldest-to-newest via `rel: next`. Returns the head memo's bridge-relative path and every new file's absolute path. */
function mintPatchMemoChain(
	kbDir: string,
	patches: CapturedPatch[],
	slug: string,
	mintUuid: () => string,
): { headRelPath: string; newFileAbsPaths: string[] } {
	const ids = patches.map(() => mintUuid());
	const newFileAbsPaths = patches.map((patch) => patch.patchAbsPath);

	for (let i = 0; i < patches.length; i += 1) {
		const patch = patches[i]!;
		const id = ids[i]!;
		const nextMemoRelPath = i + 1 < ids.length ? `kb/${ids[i + 1]}.md` : undefined;
		const { name, gist, body } = patchMemoContent(patch, slug, id);
		const absPath = join(kbDir, `${id}.md`);
		writeFileAtomic(
			absPath,
			renderPatchMemo({ id, name, gist, patchRelPath: patch.patchRelPath, body, nextMemoRelPath }),
		);
		newFileAbsPaths.push(absPath);
	}

	return { headRelPath: `kb/${ids[0]}.md`, newFileAbsPaths };
}

function appendDivePatchLinks(divePath: string, headRelPaths: string[]): void {
	if (headRelPaths.length === 0) return;
	const text = readFileSync(divePath, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(divePath));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0) {
		throw new Error(`invalid YAML in frontmatter in ${formatPath(divePath)}`);
	}

	const newLinks = headRelPaths.map((relPath) => ({ [relPath]: { rel: "patch" } }));
	const existing = doc.get("links", true);
	if (existing === undefined || existing === null) {
		doc.set("links", newLinks);
	} else if (isSeq(existing)) {
		for (const link of newLinks) existing.add(link);
	} else {
		throw new Error(`invalid links in ${formatPath(divePath)}: expected a YAML list`);
	}

	writeFileAtomic(divePath, ["---", stringifyYaml(doc).trimEnd(), "---", parsed.body].join("\n"));
}

/**
 * Deliberately no `--include-untracked`: a bridge's `workspace/<repo>` targets
 * are untracked nested git checkouts, and `git stash -u` sweeps up untracked
 * *directories* by moving them into the stash tree -- which for a nested
 * `.git` does not round-trip cleanly back out on pop. `--keep-index` clears
 * only tracked local modifications out of the way of the fast-forward merge
 * below; untracked content (workspace checkouts, stray scratch files) is never
 * touched, so it needs no protecting.
 */
function stashExceptStaged(bridgeDir: string): boolean {
	const before = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	gitRun(
		bridgeDir,
		["stash", "push", "--keep-index", "-m", "nosedive pack: temporary stash"],
		"failed to stash bridge state before pack push",
	);
	const after = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	return before !== after;
}

function commitAndPushPack(
	bridgeDir: string,
	divePath: string,
	newArtifactAbsPaths: string[],
	diveName: string,
	feat: KbDoc | undefined,
): void {
	// Pack records its phase on the feat's reciprocal link. Stage that edit
	// with the dive so it cannot linger as bridge WIP for the next pack to capture.
	const pathsToStage = [divePath, ...newArtifactAbsPaths, ...(feat ? [feat.path] : [])].map(
		(path) => toPosixPath(relative(bridgeDir, path)),
	);
	gitRun(bridgeDir, ["add", "--", ...pathsToStage], "failed to stage packed dive artifacts");

	const stashed = stashExceptStaged(bridgeDir);
	try {
		const upstream = gitOutput(bridgeDir, [
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{upstream}",
		]);
		if (!upstream) {
			throw new Error("bridge has no upstream to push to; configure one before packing");
		}
		const [remote] = upstream.split("/");
		// Fetch + merge --ff-only instead of `git pull --ff-only`: a pilot with
		// pull.rebase set globally would otherwise have that override --ff-only.
		gitRun(bridgeDir, ["fetch", remote!], "failed to fetch bridge remote before pack push");
		gitRun(
			bridgeDir,
			["merge", "--ff-only", upstream],
			"failed to fast-forward bridge before pack push; resolve manually and retry",
		);
		gitRun(
			bridgeDir,
			["commit", "-m", commitMessage(`dive(${diveName}): packed wip`, feat?.id)],
			"failed to commit packed dive",
		);
		gitRun(bridgeDir, ["push"], "failed to push bridge after pack; dive is committed locally");
	} finally {
		if (stashed) {
			gitRun(bridgeDir, ["stash", "pop"], "failed to restore stashed bridge state after pack push");
		}
	}
}

export function packDive(args: string[], io: CommandIo): void {
	if (args.length > 0) throw new Error(`pack takes no arguments: ${args.join(" ")}`);

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

	const { scopes, failures } = uniqueDiveWipScopes(dive.scopes);
	if (failures.length > 0)
		throw new Error(failures.flatMap((failure) => failure.reasons).join("; "));
	for (const scope of scopes) {
		if (!scope.ref)
			throw new Error(`scoped repo ${scope.repoId} has no pinned ref to pack against`);
	}
	const feat = dive.featRef ? resolveFeatDoc(kbDocs, rc, dive.featRef) : undefined;
	// Ahead of the scope loop, which mints `.patch` artifacts into kb/: a refusal
	// decided after it would leave orphans behind, and the newly untracked
	// artifacts would be competing with the unlinked docs the message is about.
	const linked = followLinkedKbPaths(
		kbDocs,
		dive.links.map((link) => ({ target: link.target, rel: link.rel })),
	);
	const dirtyGuard = assertDiveOwnsDirtyKb(
		dirtyKbEntries(rc.bridgeDir, rc.kbDir),
		excludedKbPaths(rc.bridgeDir, dive.path, feat?.path, []),
		linked,
	);
	if (dirtyGuard.unlinked.length > 0) {
		io.err(
			[
				"warning: pack is ignoring bridge kb dirty paths this dive does not link:",
				...dirtyGuard.unlinked.map((path) => `  ${path}`),
				"the dive will pack only linked paths and explicit bundle metadata from linked docs",
			].join("\n"),
		);
	}
	const mintUuid = createUuid7Minter();
	const groups: CapturedPatch[][] = [];
	let capturedCount = 0;

	for (const scope of scopes) {
		const resolved = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (resolved.failure) throw new Error(resolved.failure.reasons.join("; "));
		if (!resolved.path) continue;
		if (scope.readOnly) {
			const failure = checkScopedRepoWip(scope, resolved.path);
			if (failure) {
				throw new Error(
					`refusing to pack: read-only scoped repo ${scope.repoId} has unpacked work (${failure.reasons.join("; ")}); re-scope it writable or dehydrate manually first`,
				);
			}
			continue;
		}

		const patches = packRepoScope(scope, resolved.path, rc.kbDir, mintUuid);
		if (patches.length > 0) groups.push(patches);
	}
	const bridgeWip = packBridgeWip(
		rc.bridgeDir,
		rc.kbDir,
		excludedKbPaths(
			rc.bridgeDir,
			dive.path,
			feat?.path,
			groups.flat().map((patch) => patch.patchAbsPath),
		),
		linked,
		mintUuid,
	);
	if (bridgeWip) groups.push([bridgeWip]);
	const released = releaseDiveToPacker(dive.path);
	const committing = groups.length > 0 || released;
	if (committing && feat) reconcileDiveFeatLinks(feat, feat, dive.id, "packed.dive");
	const headRelPaths: string[] = [];
	const newFileAbsPaths: string[] = [];
	for (const patches of groups) {
		const slug = repoSlug(kbDocs, patches[0]!.repoId);
		const minted = mintPatchMemoChain(rc.kbDir, patches, slug, mintUuid);
		headRelPaths.push(minted.headRelPath);
		newFileAbsPaths.push(...minted.newFileAbsPaths);
		capturedCount += patches.length;
	}
	if (headRelPaths.length > 0) appendDivePatchLinks(dive.path, headRelPaths);
	// Releasing the dive is bookkeeping worth pushing on its own: a dive freed
	// with nothing to pack has to reach the shared kb before anyone can pick it up.
	if (committing) commitAndPushPack(rc.bridgeDir, dive.path, newFileAbsPaths, dive.name, feat);
	// After the push, where `land` and `bail` also drop it: a dive nobody holds
	// is not the dive the workspace is on, and leaving the marker would have
	// `append-log.dive`, `spin` and `land` reading a dive already handed back.
	const markerPath = join(rc.workspaceDir, ".nosedive-ref");
	if (existsSync(markerPath)) unlinkSync(markerPath);
	io.log(
		capturedCount > 0
			? `packed dive ${dive.id}: ${capturedCount} artifact(s)`
			: `packed dive ${dive.id}: nothing to pack`,
	);

	for (const scope of scopes) {
		const resolved = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (!resolved.path) continue;
		const ref = scope.ref;
		if (!ref) throw new Error(`scoped repo ${scope.repoId} has no pinned ref to reset to`);
		resetHydratedWorktree(scope.repoId, resolved.path, `${ref}^{commit}`);
		io.log(`reset repo=${scope.repoId} path=${formatPath(resolved.path)} ref=${ref}`);
	}
}
