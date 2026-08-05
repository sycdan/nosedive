import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isSeq, parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import {
	formatPath,
	readNosediveRc,
	resolveFrom,
	splitMarkdownFrontmatter,
	stringifyYaml,
	toPosixPath,
} from "../lib/coreParsing.js";
import {
	DiveWipScope,
	readPilotIdentity,
	readWorkspaceDiveMarker,
	uniqueDiveWipScopes,
} from "../lib/gitState.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	gitRun,
	maybeResolveRepoDoc,
} from "../lib/repoWorkspaceCore.js";
import {
	ensureDetachedAtCommit,
	ensureRepoMarkerExcluded,
	ensureReusableExistingTarget,
	expectedWorktreePath,
	isDirEmpty,
	pruneStaleWorktrees,
	resolveRefCommit,
	writeRepoMarker,
} from "../lib/repoWorktrees.js";

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
): string {
	const repoDoc = maybeResolveRepoDoc(kbDocs, scope.repoId);
	if (!repoDoc) {
		throw new Error(`active dive scope names a repo with no kb repo doc: ${scope.repoId}`);
	}
	if (!scope.ref) throw new Error(`scoped repo ${scope.repoId} has no pinned ref to hydrate at`);

	const sourcePath = ensureManagedRepoCache(repoDoc, bridgeDir);
	const targetPath = expectedWorktreePath(repoDoc, bridgeDir);
	ensureSafeTargetPath(scope.repoId, targetPath, workspaceDir);
	const commit = resolveRefCommit(sourcePath, scope.repoId, scope.ref);

	const targetExists = existsSync(targetPath);
	if (targetExists && !statSync(targetPath).isDirectory()) {
		throw new Error(
			`unsafe target path for repo ${scope.repoId}: target exists but is not a directory: ${formatPath(targetPath)}`,
		);
	}

	if (!targetExists || isDirEmpty(targetPath)) {
		mkdirSync(dirname(targetPath), { recursive: true });
		pruneStaleWorktrees(sourcePath, scope.repoId);
		gitRun(
			sourcePath,
			["worktree", "add", "--detach", targetPath, commit],
			`failed to create worktree for repo ${scope.repoId} at ${formatPath(targetPath)}`,
		);
	} else {
		ensureReusableExistingTarget(scope.repoId, targetPath, sourcePath);
		ensureDetachedAtCommit(targetPath, commit, scope.repoId);
	}
	writeRepoMarker(targetPath, scope.repoId);
	ensureRepoMarkerExcluded(targetPath, scope.repoId);

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

		steps.push({
			memoPath: memo.path,
			patchAbsPath: resolveFrom(bridgeDir, patchRel),
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

function updateDiveDocAfterJump(
	divePath: string,
	diverValue: string,
	appliedHeadIds: Set<string>,
): void {
	const text = readFileSync(divePath, "utf8");
	const block = splitMarkdownFrontmatter(text, formatPath(divePath));
	const doc = parseDocument(block.yaml);
	if (doc.errors.length > 0) {
		throw new Error(`invalid YAML in frontmatter in ${formatPath(divePath)}`);
	}

	doc.setIn(["meta", "diver"], diverValue);

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
	removedAbsPaths: string[],
	message: string,
): void {
	const pathsToStage = [divePath, ...removedAbsPaths].map((path) =>
		toPosixPath(relative(bridgeDir, path)),
	);
	gitRun(bridgeDir, ["add", "--", ...pathsToStage], "failed to stage jump dive update");

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
		gitRun(bridgeDir, ["commit", "-m", message], "failed to commit jumped dive");
		gitRun(bridgeDir, ["push"], "failed to push bridge after jump; dive is committed locally");
	} finally {
		if (stashed) {
			gitRun(bridgeDir, ["stash", "pop"], "failed to restore stashed bridge state after jump push");
		}
	}
}

function applyPatchStep(step: PatchStep, targetPath: string, label: string): void {
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

export function jump(args: string[], io: CommandIo): void {
	if (args.length > 0) throw new Error(`jump takes no arguments: ${args.join(" ")}`);

	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) {
		throw new Error(
			`jump requires an active dive marker at ${formatPath(join(rc.workspaceDir, ".nosedive-ref"))}`,
		);
	}
	if (marker.error || !marker.id) {
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);
	}

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.kind === "dive" && doc.id === marker.id);
	if (!dive) throw new Error(`active dive marker names no kind: dive doc: ${marker.id}`);

	const { scopes, failures } = uniqueDiveWipScopes(dive.scopes);
	if (failures.length > 0) {
		throw new Error(failures.flatMap((failure) => failure.reasons).join("; "));
	}

	const scopePaths = new Map<string, string>();
	for (const scope of scopes) {
		const path = hydrateScopeAtPin(scope, kbDocs, rc.bridgeDir, rc.workspaceDir);
		scopePaths.set(scope.repoId, path);
		io.log(`hydrated repo=${scope.repoId} path=${formatPath(path)}`);
	}

	const patchHeadIds = dive.links.filter((link) => link.rel === "patch").map((link) => link.id);
	const appliedHeadIds = new Set<string>();
	const appliedFileAbsPaths: string[] = [];
	let appliedCount = 0;

	for (const headId of patchHeadIds) {
		const steps = walkPatchChain(kbDocs, rc.bridgeDir, headId);
		const target = resolveChainTarget(steps[0]!.name, scopes, kbDocs, rc.bridgeDir, scopePaths);
		for (const step of steps) {
			applyPatchStep(step, target.path, target.label);
			appliedFileAbsPaths.push(step.memoPath, step.patchAbsPath);
			appliedCount += 1;
		}
		appliedHeadIds.add(headId);
	}

	const pilot = readPilotIdentity(rc.bridgeDir);
	if (!pilot.name) throw new Error("jump requires git config user.name in the bridge");
	const effortId = dive.metaScalars.effort;
	const effort = effortId ? kbDocs.find((doc) => doc.id === effortId) : undefined;
	const effortSlug = effort?.name ?? effortId ?? dive.name;
	const diverValue = `${pilot.name} picked up ${effortSlug}`;

	updateDiveDocAfterJump(dive.path, diverValue, appliedHeadIds);
	for (const path of appliedFileAbsPaths) {
		if (existsSync(path)) unlinkSync(path);
	}

	commitAndPushJump(rc.bridgeDir, dive.path, appliedFileAbsPaths, diverValue);

	writeFileAtomic(join(rc.workspaceDir, ".nosedive-ref"), `id: ${dive.id}\n`);

	io.log(
		appliedCount > 0
			? `jumped dive ${dive.id}: applied ${appliedCount} artifact(s)`
			: `jumped dive ${dive.id}: nothing to unpack`,
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(jump, args);
}
