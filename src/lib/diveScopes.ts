import { existsSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import { defaultWorkBranch, formatPath, NosediveRc, uuidLike } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { KbDoc, ScopeRef } from "./kbDocs.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	maybeResolveRepoDoc,
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

/**
 * A repo named the way a pilot names it: `--upscope nosedive` resolves the
 * `kind: repo` doc called `nosedive`. Name resolution runs first because a repo
 * name is a shorter thing to type than a uuid and cannot be confused for a
 * path, and the remaining forms -- uuid, kb path, `.nosedive-ref`, a directory
 * holding one -- fall through to the general document resolver behind it.
 */
export function resolveScopeRepo(bridgeDir: string, kbDocs: KbDoc[], ref: string): KbDoc {
	const named = maybeResolveRepoDoc(kbDocs, ref);
	if (named) return named;
	const doc = uuidLike(ref)
		? kbDocs.find((candidate) => candidate.id === ref)
		: resolveBridgeDocRef(bridgeDir, kbDocs, ref);
	if (!doc) throw new Error(`kb document not found: ${ref}`);
	if (doc.kind !== "repo") throw new Error(`scope does not resolve to a kind: repo doc: ${ref}`);
	return doc;
}

/**
 * A repo resolved to a pinned scope, and nothing more: no branch, so read-only
 * until a feat hands one down or `--upscope` names one.
 *
 * Two earlier answers to "is this writable" are gone. It was read off
 * `remote.origin.pushurl` in whatever worktree happened to be on disk, which
 * gate hydration turned into a trap -- a `nosedive test` sweep left read-only
 * worktrees behind and every dive recorded afterwards inherited `ro`. Then it
 * came from `meta.default-mode` on the repo doc, which nothing rendered and
 * `--upscope` ignored. Naming a branch is the only answer now.
 */
export function cachedScope(repo: KbDoc, bridgeDir: string, workspaceDir: string): ScopeRef {
	const path = expectedWorktreePath(repo, bridgeDir);
	ensureSafeTargetPath(repo.id, path, workspaceDir);
	if (existsSync(path) && statSync(path).isDirectory() && existsSync(join(path, ".nosedive-ref"))) {
		const marker = parseRepoMarkerStrict(join(path, ".nosedive-ref"));
		if (marker.id !== repo.id)
			throw new Error(`workspace marker does not match repo ${repo.id}: ${formatPath(path)}`);
	}
	const cache = ensureManagedRepoCache(repo, bridgeDir);
	const trunk = repo.repoBaseBranch ?? "main";
	return {
		repoId: repo.id,
		path: "",
		ref: resolveRefCommit(cache, repo.id, trunk),
		readOnly: true,
		flags: [],
	};
}

/**
 * A repin of the dive the workspace is on is refused rather than applied.
 *
 * Hydration built those worktrees from the pin this would move, so afterwards
 * the dive would describe a state no checkout is in and the next `jump` would
 * replay work onto a tree it never started from. Releasing the dive first is the
 * whole of the fix, so the message names the command that does it.
 */
export function ensureRepinnable(dive: KbDoc, active: KbDoc | undefined): void {
	if (active?.id !== dive.id) return;
	throw new Error(
		`dive ${dive.id} is the active workspace dive; \`pack\` it before repinning -- ` +
			`its worktrees were hydrated from the pin this would move`,
	);
}

/**
 * Where a repin puts one scope: the head of the first named branch origin has,
 * and trunk when it has none of them.
 *
 * Origin is the only place a branch may answer from. The managed cache is a bare
 * clone, so it carries a local branch for every name origin held when it was
 * made, and resolving there would pin a dive at a commit no other machine can
 * reach. A branch origin does not have is skipped rather than raised: the first
 * dive on a feat has pushed nothing yet, and trunk is the honest answer for it.
 *
 * `cachedScope` resolves trunk even when a branch goes on to answer, because it
 * is also what runs the target-path and workspace-marker checks, and its fetch
 * is what puts origin's current heads in the cache for the probe below to read.
 * That fetch is load-bearing past the pin itself: `land` publishes to the origin
 * URL rather than the remote name, so a stacked dive only sees its predecessor's
 * landed commits once a repin has fetched them.
 */
function repinnedRef(
	repo: KbDoc,
	bridgeDir: string,
	workspaceDir: string,
	candidates: [source: string, branch: string | undefined][],
): { ref: string | undefined; source: string } {
	const trunk = repo.repoBaseBranch ?? "main";
	const trunkRef = cachedScope(repo, bridgeDir, workspaceDir).ref;
	const cache = ensureManagedRepoCache(repo, bridgeDir);
	for (const [source, branch] of candidates) {
		if (!branch) continue;
		const head = gitOutput(cache, [
			"rev-parse",
			"--verify",
			`refs/remotes/origin/${branch}^{commit}`,
		]);
		if (head) return { ref: head, source: `${source} ${branch}` };
	}
	return { ref: trunkRef, source: `trunk ${trunk}` };
}

/**
 * Every scope moved to the head of the branch that speaks for it, and nothing
 * else about them touched.
 *
 * A pin is the one field a dive cannot correct for itself: `--upscope`
 * deliberately keeps the pin it finds, and replacing the scope set to move one
 * ref drops the branch with it. Re-resolving in place is the whole operation.
 *
 * Trunk is the last answer rather than the only one. A dive stacked on another
 * needs the branch its predecessor published to, which is a ref and not a commit
 * anyone should have to name by hand, so the scope's own branch is asked first
 * and the feat's branch for that repo second. Both are read on origin, and both
 * fall through to trunk when origin does not have them.
 *
 * Every move is reported with the source that answered it. A repin can retarget
 * a dive onto a branch somebody else pushed to, and that is exactly the outcome
 * that must not be silent.
 *
 * A scope still carrying the superseded `mode: rw` is the one entry that has to
 * change to stay the same. `mode` is never written back, so rewriting the entry
 * without the branch its feat hands down is how a landable dive quietly becomes
 * read-only -- and unlike `--upscope` or `--clear-scopes`, a repin is nobody
 * saying they wanted that. Where the feat declares no branch there is nothing to
 * inherit, and the narrowing is reported instead of happening in silence.
 */
export function repinScopes(
	scopes: ScopeRef[],
	rc: NosediveRc,
	kbDocs: KbDoc[],
	workspaceDir: string,
	feat: KbDoc | undefined,
	io: CommandIo,
): ScopeRef[] {
	return scopes.map((scope) => {
		const repo = resolveScopeRepo(rc.bridgeDir, kbDocs, scope.repoId);
		const inherited = featWorkBranch(scope.repoId, rc, kbDocs, feat);
		const { ref, source } = repinnedRef(repo, rc.bridgeDir, workspaceDir, [
			["work-branch", scope.workBranch],
			["feat branch", inherited],
		]);
		io.log(`${repo.name}: ${scope.ref} -> ${ref} (${source})`);
		if (scope.workBranch || scope.legacyMode !== "rw") return { ...scope, ref };
		if (!inherited) {
			io.err(
				`scope ${repo.name} was writable as mode: rw and its feat declares no branch for it; ` +
					`it is read-only now -- give it one with \`--upscope ${repo.name}\``,
			);
			return { ...scope, ref };
		}
		return { ...scope, ref, readOnly: false, workBranch: inherited };
	});
}

/** `parent`, plus the role-suffixed spellings a deck-rooted tree uses (`parent.feat`, `parent.deck`). */
function isParentRel(rel: string | undefined): boolean {
	return rel === "parent" || (rel?.startsWith("parent.") ?? false);
}

/**
 * The branch an upscoped repo publishes to, most specific first: what the pilot
 * typed, then what the feat already decided for that repo, then a generated
 * name.
 *
 * The feat's own entry comes before generation because a feat that has declared
 * where a repo lands has answered the question already, and every dive under it
 * should agree rather than each inventing the default afresh.
 */
export function upscopeBranch(
	repoId: string,
	requested: string | undefined,
	rc: NosediveRc,
	kbDocs: KbDoc[],
	feat: KbDoc | undefined,
): string | undefined {
	if (requested) return requested;
	return (
		featWorkBranch(repoId, rc, kbDocs, feat) ??
		(feat ? defaultWorkBranch(rc, feat.name) : undefined)
	);
}

/**
 * Where a feat says one of its repos lands, or undefined when it has not said.
 *
 * The answer comes from the same ancestor the scopes themselves come from -- a
 * feat that declares no scopes has declared nothing about branches either, and
 * looking only at the named feat would drop the branch its parent chose.
 *
 * An ancestor scope still carrying the superseded `mode: rw` counts as having
 * said so: it was written to mean "dives on me push this repo", and the branch
 * it meant is the one `land` used to compute for itself. A feat that says
 * nothing hands down nothing, and the dive stays unpushable until somebody
 * upscopes it.
 */
export function featWorkBranch(
	repoId: string,
	rc: NosediveRc,
	kbDocs: KbDoc[],
	feat: KbDoc | undefined,
): string | undefined {
	if (!feat) return undefined;
	const { scopes, source } = inheritedScopes(feat, kbDocs);
	const declared = scopes.find((scope) => scope.repoId === repoId);
	if (!declared || !source) return undefined;
	if (declared.workBranch) return declared.workBranch;
	return declared.legacyMode === "rw" ? defaultWorkBranch(rc, source.name) : undefined;
}

/**
 * A read-only scope is written as the repo and its pin and nothing else: naming
 * no branch is what read-only means, so there is no key that says so. `mode` is
 * never written -- `mode: ro` said the same thing twice and `mode: rw` said
 * something a branch says better.
 */
export function renderScopeEntry(scope: ScopeRef): Record<string, unknown> {
	return {
		[scope.repoId]: scope.workBranch
			? { ref: scope.ref, "work-branch": scope.workBranch }
			: { ref: scope.ref },
	};
}

/**
 * Applies `--upscope` and `--unscope` to a scope set: at create, the one
 * inherited from the feat; on `--ref`, the one the dive already records.
 *
 * An `--unscope` naming a repo that is not scoped is a no-op rather than an
 * error: the pilot asked for it gone, and it is. One `--work-branch` covers
 * every `--upscope` in the call, which is the point of composing them --
 * several repos moving together belong on one branch.
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
		const workBranch = upscopeBranch(repo.id, edits.workBranch, rc, kbDocs, feat);
		if (!workBranch) {
			throw new Error(
				`--upscope ${ref} needs a branch: this dive names no feat, so pass --work-branch`,
			);
		}
		const upscoped: ScopeRef = { ...base, readOnly: false, workBranch };
		if (existing) scopes[scopes.indexOf(existing)] = upscoped;
		else scopes.push(upscoped);
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
export function inheritedScopes(
	feat: KbDoc,
	kbDocs: KbDoc[],
): { scopes: ScopeRef[]; source?: KbDoc } {
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const seen = new Set<string>();
	let current: KbDoc | undefined = feat;
	while (current && !seen.has(current.id)) {
		if (current.scopes.length > 0) return { scopes: current.scopes, source: current };
		seen.add(current.id);
		current = current.links
			.filter((link) => isParentRel(link.rel))
			.map((link) => byId.get(link.id))
			.find((doc): doc is KbDoc => doc !== undefined);
	}
	return { scopes: [] };
}

/**
 * The create-time spelling of `renderScopeEntry`, emitting lines rather than a
 * value because a new dive's frontmatter is assembled as text. Neither writes
 * `mode`: the branch says where work goes, and its absence says nowhere.
 */
export function renderScopes(scopes: ScopeRef[]): string[] {
	if (scopes.length === 0) return ["scopes: []"];
	const lines = ["scopes:"];
	for (const scope of scopes) {
		lines.push(`  - ${scope.repoId}:`, `      ref: ${scope.ref}`);
		if (scope.workBranch) lines.push(`      work-branch: ${scope.workBranch}`);
	}
	return lines;
}
