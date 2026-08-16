import { existsSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { defaultWorkBranch, formatPath, NosediveRc, uuidLike } from "./coreParsing.js";
import { KbDoc, ScopeRef } from "./kbDocs.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	parseRepoMarkerStrict,
} from "./repoWorkspaceCore.js";
import { expectedWorktreePath, resolveRefCommit } from "./repoWorktrees.js";

/**
 * Resolving what a dive scopes, and rendering it back out.
 *
 * Split from `recordDive` because it is a seam rather than a slice of the
 * command: nothing here knows about flags, briefs or divers, and everything
 * here is about turning a repo reference into a pinned, landable scope entry.
 */

function bridgeRelativePath(bridgeDir: string, pathRef: string): string {
	if (!pathRef || pathRef.includes("\\"))
		throw new Error(`invalid bridge-relative path: ${pathRef}`);
	const path = resolve(bridgeDir, pathRef);
	if (relative(bridgeDir, path).startsWith("..")) {
		throw new Error(`path resolves outside this bridge: ${pathRef}`);
	}
	if (!existsSync(path)) throw new Error(`path not found: ${pathRef}`);
	return path;
}

function docFromMarker(path: string, kbDocs: KbDoc[]): KbDoc {
	const markerPath = statSync(path).isDirectory() ? join(path, ".nosedive-ref") : path;
	if (basename(markerPath) !== ".nosedive-ref")
		throw new Error(`not a document or .nosedive-ref: ${formatPath(path)}`);
	const marker = parseRepoMarkerStrict(markerPath);
	const doc = kbDocs.find((candidate) => candidate.id === marker.id);
	if (!doc) throw new Error(`marker references no kb document: ${formatPath(markerPath)}`);
	return doc;
}

export function resolveBridgeDocRef(bridgeDir: string, kbDocs: KbDoc[], ref: string): KbDoc {
	if (uuidLike(ref)) {
		const doc = kbDocs.find((candidate) => candidate.id === ref);
		if (!doc) throw new Error(`kb document not found: ${ref}`);
		return doc;
	}
	const path = bridgeRelativePath(bridgeDir, ref);
	if (basename(path) === ".nosedive-ref") return docFromMarker(path, kbDocs);
	if (statSync(path).isDirectory()) return docFromMarker(path, kbDocs);
	if (!statSync(path).isFile()) throw new Error(`not a document or .nosedive-ref: ${ref}`);
	const doc = kbDocs.find((candidate) => resolve(candidate.path) === path);
	if (!doc) throw new Error(`file is not a kb document: ${ref}`);
	return doc;
}

export function resolveScopeRepo(bridgeDir: string, kbDocs: KbDoc[], ref: string): KbDoc {
	const doc = uuidLike(ref)
		? kbDocs.find((candidate) => candidate.id === ref)
		: resolveBridgeDocRef(bridgeDir, kbDocs, ref);
	if (!doc) throw new Error(`kb document not found: ${ref}`);
	if (doc.kind !== "repo") throw new Error(`scope does not resolve to a kind: repo doc: ${ref}`);
	return doc;
}

function defaultReadOnly(repo: KbDoc): boolean {
	const mode = repo.metaScalars["default-mode"];
	if (mode === undefined || mode === "rw") return false;
	if (mode === "ro") return true;
	throw new Error(`repo ${repo.id} has invalid meta.default-mode: ${mode}`);
}

/**
 * Whether a scope is writable is a declaration, and it is taken from the repo
 * doc alone.
 *
 * It used to be read back off `remote.origin.pushurl` in whatever worktree
 * happened to be on disk, which was survivable only while a hydrated worktree
 * meant a pilot had asked for one. Gate hydration ended that: a `nosedive test`
 * sweep leaves read-only worktrees behind, so every dive recorded afterwards
 * inherited `ro` and could never be landed. A worktree is the consequence of a
 * mode and was never evidence of one.
 */
export function cachedScope(repo: KbDoc, bridgeDir: string, workspaceDir: string): ScopeRef {
	const path = expectedWorktreePath(repo, bridgeDir);
	ensureSafeTargetPath(repo.id, path, workspaceDir);
	if (existsSync(path) && statSync(path).isDirectory() && existsSync(join(path, ".nosedive-ref"))) {
		const marker = parseRepoMarkerStrict(join(path, ".nosedive-ref"));
		if (marker.id !== repo.id)
			throw new Error(`workspace marker does not match repo ${repo.id}: ${formatPath(path)}`);
	}
	const readOnly = defaultReadOnly(repo);
	const cache = ensureManagedRepoCache(repo, bridgeDir);
	const trunk = repo.repoBaseBranch ?? "main";
	return {
		repoId: repo.id,
		path: "",
		ref: resolveRefCommit(cache, repo.id, trunk),
		readOnly,
		flags: [],
	};
}

/** `parent`, plus the role-suffixed spellings a deck-rooted tree uses (`parent.feat`, `parent.deck`). */
function isParentRel(rel: string | undefined): boolean {
	return rel === "parent" || (rel?.startsWith("parent.") ?? false);
}

/**
 * Gives a writable scope the branch `land` will publish it to. Feat-derived, so
 * every dive on one feat shares a branch exactly as `land` computed it before
 * the name lived on the scope; a scope wanting its own is set afterwards.
 */
export function stampWorkBranch(
	scope: ScopeRef,
	rc: NosediveRc,
	feat: KbDoc | undefined,
): ScopeRef {
	if (scope.readOnly || scope.workBranch) return scope;
	if (!feat) return scope;
	return { ...scope, workBranch: defaultWorkBranch(rc, feat.name) };
}

export function renderScopeEntry(scope: ScopeRef): Record<string, unknown> {
	return {
		[scope.repoId]: scope.readOnly
			? { ref: scope.ref, mode: "ro" }
			: { ref: scope.ref, "work-branch": scope.workBranch },
	};
}

/**
 * Applies `--upscope` and `--unscope` to the scope set a dive already records,
 * rather than replacing it the way `--scope` does.
 *
 * Both take repo refs and are resolved against the kb, so a name works wherever
 * a uuid does. An `--unscope` naming a repo the dive does not scope is a no-op
 * rather than an error: the pilot asked for it gone, and it is.
 *
 * One `--work-branch` covers every `--upscope` in the call, which is the point
 * of composing them -- several repos moving together belong on one branch.
 */
export interface ScopeEdits {
	upscopes: string[];
	unscopes: string[];
	workBranch?: string;
}

export function editScopes(
	current: ScopeRef[],
	edits: ScopeEdits,
	rc: NosediveRc,
	kbDocs: KbDoc[],
	workspaceDir: string,
	feat: KbDoc | undefined,
): ScopeRef[] {
	const repoId = (ref: string) => resolveScopeRepo(rc.bridgeDir, kbDocs, ref).id;
	const dropped = new Set(edits.unscopes.map(repoId));
	const scopes = current.filter((scope) => !dropped.has(scope.repoId));

	for (const ref of edits.upscopes) {
		const repo = resolveScopeRepo(rc.bridgeDir, kbDocs, ref);
		// The pin is the dive's business, so an already-scoped repo keeps the one it
		// has: upscoping decides where work goes, never which commit it started at.
		const existing = scopes.find((scope) => scope.repoId === repo.id);
		const base = existing ?? cachedScope(repo, rc.bridgeDir, workspaceDir);
		const upscoped: ScopeRef = {
			...base,
			readOnly: false,
			workBranch: edits.workBranch,
		};
		const stamped = stampWorkBranch(upscoped, rc, feat);
		if (!stamped.workBranch) {
			throw new Error(
				`--upscope ${ref} needs a branch: this dive names no feat, so pass --work-branch`,
			);
		}
		if (existing) scopes[scopes.indexOf(existing)] = stamped;
		else scopes.push(stamped);
	}
	return scopes;
}

/**
 * The scopes a dive under this feat should start from. `pitch` never writes a
 * scopes key, so reading only the feat's own scopes records a dive with none,
 * and a dive with no scope can be jumped with no repo attached and landed
 * without pushing anything. The nearest scoped ancestor is the one the pitcher
 * meant, so the walk stops there instead of unioning the whole chain.
 */
export function inheritedScopes(feat: KbDoc, kbDocs: KbDoc[]): ScopeRef[] {
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const seen = new Set<string>();
	let current: KbDoc | undefined = feat;
	while (current && !seen.has(current.id)) {
		if (current.scopes.length > 0) return current.scopes;
		seen.add(current.id);
		current = current.links
			.filter((link) => isParentRel(link.rel))
			.map((link) => byId.get(link.id))
			.find((doc): doc is KbDoc => doc !== undefined);
	}
	return [];
}

/**
 * `mode: rw` is never written again -- the branch says it. `mode: ro` still is,
 * because absence of a branch has always meant a writable bare scope and cannot
 * be repurposed without stranding every scope written before this.
 */
export function renderScopes(scopes: ScopeRef[]): string[] {
	if (scopes.length === 0) return ["scopes: []"];
	const lines = ["scopes:"];
	for (const scope of scopes) {
		lines.push(`  - ${scope.repoId}:`, `      ref: ${scope.ref}`);
		if (scope.readOnly) {
			lines.push(`      mode: ro`);
			continue;
		}
		if (!scope.workBranch)
			throw new Error(`writable scope ${scope.repoId} has no work branch to record`);
		lines.push(`      work-branch: ${scope.workBranch}`);
	}
	return lines;
}
