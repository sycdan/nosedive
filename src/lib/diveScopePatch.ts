import type { CommandIo } from "./bridgeSetupIo.js";
import { readNosediveRc } from "./coreParsing.js";
import type { CrudTarget } from "./crud.js";
import {
	editScopes,
	pinnedScope,
	renderScopeEntry,
	repinScopes,
	resolveScopeRepo,
	type RepinTarget,
} from "./diveScopes.js";
import { loadKbDocs, readKbDoc, type ScopeRef } from "./kbDocs.js";
import { isMapping, mergePatch } from "./mergePatch.js";
import { resolveFeatDoc } from "./repoFeatScopes.js";

/** A dive as crud found it, with what its scope edits resolve against: its own kb's docs and feat. */
function diveInPlace(target: CrudTarget) {
	const rc = readNosediveRc(process.cwd());
	if (!rc.workspaceDir) throw new Error("a dive's scopes need a configured workspace directory");
	const kbDocs = loadKbDocs(target.source.kbDir, target.source.root);
	const dive = readKbDoc(target.path, target.source.root);
	if (dive.kind !== "dive") throw new Error(`${dive.id} is a ${dive.kind}, not a dive`);
	const feat = dive.featRef ? resolveFeatDoc(kbDocs, rc, dive.featRef) : undefined;
	return { rc, workspaceDir: rc.workspaceDir, kbDocs, dive, feat };
}

const block = (scopes: ScopeRef[]) =>
	Object.assign({}, ...scopes.map(renderScopeEntry)) as Record<string, unknown>;

/** `crud <dive> --repin`: record.dive's repin, as the dive's whole new `scopes:` block. */
export function diveRepinPatch(target: CrudTarget, repin: RepinTarget, io: CommandIo) {
	const { rc, workspaceDir, kbDocs, dive, feat } = diveInPlace(target);
	return block(repinScopes(dive.scopes, rc, kbDocs, workspaceDir, feat, io, repin));
}

/**
 * `crud <dive> --scopes -`, made as record.dive makes the same edit: a null
 * drops a scope as `--unscope` does; a new scope is pinned and takes its
 * branch as `--upscope` gives one, or none for `work-branch: null`; a scope
 * already there keeps its pin. With `replace`, a scope the patch leaves out
 * is dropped. Returns the dive's whole new `scopes:` block, keyed by repo id.
 */
export function diveScopesPatch(
	target: CrudTarget,
	patch: Record<string, unknown>,
	replace: boolean,
): Record<string, unknown> {
	const { rc, workspaceDir, kbDocs, dive, feat } = diveInPlace(target);
	const named = Object.entries(patch).map(([ref, value]) => {
		if (value !== null && !isMapping(value))
			throw new Error(`--scopes ${ref} takes a mapping, or null to drop it`);
		if (value && "ref" in value)
			throw new Error(`a dive's pin moves with crud ${dive.id} --repin, not --scopes`);
		return { repo: resolveScopeRepo(rc.bridgeDir, kbDocs, ref), value };
	});
	const kept = new Set(named.filter(({ value }) => value).map(({ repo }) => repo.id));
	const unscopes = [
		...named.filter(({ value }) => !value).map(({ repo }) => repo.id),
		...(replace ? dive.scopes.map((scope) => scope.repoId).filter((id) => !kept.has(id)) : []),
	];
	let scopes = editScopes(dive.scopes, { upscopes: [], unscopes }, rc, kbDocs, workspaceDir, feat);
	for (const { repo, value } of named) {
		if (!value) continue;
		const { "work-branch": branch, ...rest } = value;
		const at = scopes.findIndex((scope) => scope.repoId === repo.id);
		if (branch === null) {
			const base = scopes[at] ?? pinnedScope(repo, rc.bridgeDir, workspaceDir, undefined);
			const readOnly: ScopeRef = { ...base, readOnly: true, workBranch: undefined };
			scopes =
				at === -1 ? [...scopes, readOnly] : scopes.map((scope, i) => (i === at ? readOnly : scope));
		} else if (branch !== undefined || at === -1) {
			if (branch !== undefined && (typeof branch !== "string" || !branch.trim()))
				throw new Error(`--scopes ${repo.name} work-branch names a branch, or is null for none`);
			const workBranch = branch?.trim();
			scopes = editScopes(
				scopes,
				{ upscopes: [repo.id], unscopes: [], workBranch },
				rc,
				kbDocs,
				workspaceDir,
				feat,
			);
		}
		if (Object.values(rest).some((attr) => attr !== null && typeof attr === "object"))
			throw new Error(`--scopes ${repo.name} takes only scalar keys`);
		scopes = scopes.map((scope) =>
			scope.repoId === repo.id
				? { ...scope, attrs: mergePatch(scope.attrs, rest) as Record<string, string> }
				: scope,
		);
	}
	return block(scopes);
}
