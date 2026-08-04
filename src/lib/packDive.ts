import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isSeq, parseDocument } from "yaml";

import { CommandIo, createUuid7Minter } from "./bridgeSetupIo.js";
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
import { loadKbDocs } from "./kbDocs.js";
import { gitOutput, writeFileAtomic } from "./renderPlan.js";
import { gitRun, runGit } from "./repoWorkspaceCore.js";
import { ensureDehydrateTargetOwnership, removeHydratedWorktree } from "./repoWorktrees.js";

export interface PackedArtifact {
	repoId: string;
	relPath: string;
	absPath: string;
	sha?: string;
	message?: string;
	dirty?: boolean;
}

function writeArtifact(
	kbDir: string,
	id: string,
	content: string,
): { relPath: string; absPath: string } {
	const absPath = join(kbDir, "artifacts", `${id}.patch`);
	writeFileAtomic(absPath, content);
	return { relPath: `kb/artifacts/${id}.patch`, absPath };
}

// --- per-repo capture --------------------------------------------------------

function listAheadCommits(repoPath: string, pin: string, repoId: string): string[] {
	const raw = gitRun(
		repoPath,
		["rev-list", "--reverse", `${pin}..HEAD`],
		`failed to list commits ahead of pin for repo ${repoId}`,
	);
	return raw ? raw.split(/\r?\n/).filter(Boolean) : [];
}

function untrackedFiles(repoPath: string): string[] {
	const raw = gitOutput(repoPath, ["ls-files", "--others", "--exclude-standard"]);
	return raw ? raw.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * `git diff <commit>` (no `--cached`) already folds staged and unstaged
 * changes into one patch against that commit; intent-to-add is what pulls
 * untracked files into that same diff without ever writing their blobs to a
 * real commit. The intent-to-add markers are reset afterward so a failed pack
 * leaves the worktree exactly as it found it.
 */
function captureDirtyPatch(repoPath: string, repoId: string): string | undefined {
	const status = gitOutput(repoPath, ["status", "--porcelain"]);
	if (!status || !status.trim()) return undefined;

	const untracked = untrackedFiles(repoPath);
	if (untracked.length > 0) {
		gitRun(
			repoPath,
			["add", "--intent-to-add", "--", ...untracked],
			`failed to stage untracked files for repo ${repoId} pack`,
		);
	}
	try {
		return gitRun(
			repoPath,
			["diff", "--binary", "HEAD"],
			`failed to capture dirty diff for repo ${repoId}`,
		);
	} finally {
		if (untracked.length > 0) {
			gitRun(
				repoPath,
				["reset", "--", ...untracked],
				`failed to unstage intent-to-add markers for repo ${repoId}`,
			);
		}
	}
}

function packRepoScope(
	scope: DiveWipScope,
	repoPath: string,
	kbDir: string,
	mintUuid: () => string,
): PackedArtifact[] {
	if (!scope.ref) throw new Error(`scoped repo ${scope.repoId} has no pinned ref to pack against`);

	const entries: PackedArtifact[] = [];
	for (const sha of listAheadCommits(repoPath, scope.ref, scope.repoId)) {
		const patch = gitRun(
			repoPath,
			["format-patch", "-1", sha, "--stdout", "--binary", "--no-signature"],
			`failed to format patch for repo ${scope.repoId} commit ${sha}`,
		);
		const message = gitRun(
			repoPath,
			["log", "-1", "--format=%s", sha],
			`failed to read commit subject for repo ${scope.repoId} commit ${sha}`,
		);
		const id = mintUuid();
		const written = writeArtifact(kbDir, id, patch);
		entries.push({ repoId: scope.repoId, ...written, sha, message });
	}

	const dirtyPatch = captureDirtyPatch(repoPath, scope.repoId);
	if (dirtyPatch !== undefined) {
		const id = mintUuid();
		const written = writeArtifact(kbDir, id, dirtyPatch);
		entries.push({ repoId: scope.repoId, ...written, dirty: true });
	}

	return entries;
}

// --- bridge kb/ wip capture ---------------------------------------------------

function packBridgeWip(
	bridgeDir: string,
	kbDir: string,
	divePath: string,
	excludeAbsPaths: string[],
	mintUuid: () => string,
): PackedArtifact | undefined {
	const kbRel = toPosixPath(relative(bridgeDir, kbDir));
	// `gitOutput` trims the whole response, which would eat the leading status
	// space of the first porcelain line; `--untracked-files=all` is what stops
	// an entirely-untracked directory (like a first-ever kb/artifacts/) from
	// collapsing into one un-parseable directory line.
	const statusResult = runGit(bridgeDir, [
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		kbRel,
	]);
	if (!statusResult.stdout.trim()) return undefined;

	const excluded = new Set(
		[divePath, ...excludeAbsPaths].map((path) => toPosixPath(relative(bridgeDir, path))),
	);
	const statusLines = statusResult.stdout.split(/\r?\n/).filter((line) => line.length > 0);
	const dirtyKbFiles = statusLines
		.map((line) => line.slice(3))
		.filter((path) => !excluded.has(path));
	if (dirtyKbFiles.length === 0) return undefined;

	const untracked = statusLines
		.filter((line) => line.startsWith("??"))
		.map((line) => line.slice(3))
		.filter((path) => dirtyKbFiles.includes(path));
	if (untracked.length > 0) {
		gitRun(
			bridgeDir,
			["add", "--intent-to-add", "--", ...untracked],
			"failed to stage untracked bridge kb/ files for pack",
		);
	}
	let diff: string;
	try {
		diff = gitRun(
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
	return { repoId: "", ...written, dirty: true };
}

// --- dive doc mutation ---------------------------------------------------------

function linkEntryFor(artifact: PackedArtifact): Record<string, unknown> {
	const value: Record<string, unknown> = artifact.repoId
		? { rel: "wip-patch", repo: artifact.repoId }
		: { rel: "bridge-wip" };
	if (artifact.sha) value.sha = artifact.sha;
	if (artifact.message !== undefined) value.message = artifact.message;
	if (artifact.dirty) value.dirty = true;
	return { [artifact.relPath]: value };
}

function appendDiveLinks(divePath: string, artifacts: PackedArtifact[]): void {
	if (artifacts.length === 0) return;
	const text = readFileSync(divePath, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(divePath));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0) {
		throw new Error(`invalid YAML in frontmatter in ${formatPath(divePath)}`);
	}

	const newLinks = artifacts.map(linkEntryFor);
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

// --- bridge commit + push ------------------------------------------------------

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
): void {
	const pathsToStage = [divePath, ...newArtifactAbsPaths].map((path) =>
		toPosixPath(relative(bridgeDir, path)),
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
			["commit", "-m", `dive(${diveName}): packed wip`],
			"failed to commit packed dive",
		);
		gitRun(bridgeDir, ["push"], "failed to push bridge after pack; dive is committed locally");
	} finally {
		if (stashed) {
			gitRun(bridgeDir, ["stash", "pop"], "failed to restore stashed bridge state after pack push");
		}
	}
}

// --- entrypoint ------------------------------------------------------------

export function packDive(args: string[], io: CommandIo): void {
	if (args.length > 0) throw new Error(`pack takes no arguments: ${args.join(" ")}`);

	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) {
		throw new Error(
			`pack requires an active dive marker at ${formatPath(join(rc.workspaceDir, ".nosedive-ref"))}`,
		);
	}
	if (marker.error || !marker.id) {
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);
	}

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.kind === "dive" && doc.id === marker.id);
	if (!dive) throw new Error(`active dive marker names no kind: dive doc: ${marker.id}`);

	const { scopes, failures } = uniqueDiveWipScopes(dive.scopes);
	if (failures.length > 0)
		throw new Error(failures.flatMap((failure) => failure.reasons).join("; "));

	const mintUuid = createUuid7Minter();
	const artifacts: PackedArtifact[] = [];

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

		artifacts.push(...packRepoScope(scope, resolved.path, rc.kbDir, mintUuid));
	}

	const bridgeWip = packBridgeWip(
		rc.bridgeDir,
		rc.kbDir,
		dive.path,
		artifacts.map((artifact) => artifact.absPath),
		mintUuid,
	);
	if (bridgeWip) artifacts.push(bridgeWip);

	if (artifacts.length > 0) {
		appendDiveLinks(dive.path, artifacts);
		commitAndPushPack(
			rc.bridgeDir,
			dive.path,
			artifacts.map((artifact) => artifact.absPath),
			dive.name,
		);
		io.log(`packed dive ${dive.id}: ${artifacts.length} artifact(s)`);
	} else {
		io.log(`packed dive ${dive.id}: nothing to pack`);
	}

	for (const scope of scopes) {
		const resolved = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (!resolved.path) continue;
		ensureDehydrateTargetOwnership(scope.repoId, resolved.path);
		removeHydratedWorktree(scope.repoId, resolved.path, true);
		io.log(`dehydrated repo=${scope.repoId} path=${formatPath(resolved.path)}`);
	}
}
