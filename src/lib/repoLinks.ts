import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { builtinDocPath } from "./builtinKinds.js";
import { toPosixPath, type NosediveRc } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { readKbDoc, type KbDoc, type LinkRef, type ScopeRef } from "./kbDocs.js";
import { splitRepoRef } from "./kbRefs.js";
import { ensureManagedRepoCache, managedCachePath } from "./repoWorkspaceCore.js";
import { expectedWorktreePath, maybeFetchSource } from "./repoWorktrees.js";

/**
 * A `<repo-quid>:<path>` ref names a file in another repo. It is read from that
 * repo's hydrated checkout when there is one -- on a dive, the dive's -- and
 * otherwise from the managed cache at trunk.
 */

/** A repo other than the bridge, where it is hydrated in the workspace. */
export function repoCheckout(rc: NosediveRc, repo: KbDoc): string | undefined {
	const root = expectedWorktreePath(repo, rc.bridgeDir);
	const marker = join(root, ".nosedive-ref");
	return existsSync(marker) && readFileSync(marker, "utf8").includes(repo.id) ? root : undefined;
}

/**
 * A file in a repo other than the bridge, and the checkout it was read from,
 * if any. `prepare` makes the managed cache when there is none, which fetches;
 * without it a repo never cached has nothing to read.
 */
export function readRepoFile(
	rc: NosediveRc,
	repo: KbDoc,
	path: string,
	prepare: boolean,
): { text: string; file: string; checkout?: string } | undefined {
	const checkout = repoCheckout(rc, repo);
	if (checkout) {
		const file = join(checkout, path);
		if (!existsSync(file) || !statSync(file).isFile()) return undefined;
		return { text: readFileSync(file, "utf8"), file, checkout };
	}
	const cache = managedCachePath(repo.id, rc.bridgeDir);
	if (!existsSync(cache)) {
		if (!prepare) return undefined;
		ensureManagedRepoCache(repo, rc.bridgeDir);
		maybeFetchSource(cache, repo.id);
	}
	const trunk = repo.repoBaseBranch ?? "main";
	const text = gitOutput(cache, ["show", `refs/remotes/origin/${trunk}:${toPosixPath(path)}`]);
	return text === undefined ? undefined : { text, file: join(cache, path) };
}

/** A kb doc in a repo other than the bridge, carrying where it came from. */
export function readRepoDoc(
	rc: NosediveRc,
	repo: KbDoc,
	path: string,
	prepare: boolean,
): KbDoc | undefined {
	// A link back names the bridge by its repo id, so a bridge without one cannot make one.
	if (!rc.bridge) return undefined;
	const found = readRepoFile(rc, repo, path, prepare);
	if (!found) return undefined;
	const root = found.checkout ?? managedCachePath(repo.id, rc.bridgeDir);
	const doc = readKbDoc(found.file, root, found.text);
	return { ...doc, home: { repoId: repo.id, bridgeId: rc.bridge, checkout: found.checkout } };
}

/**
 * The doc a `<repo-quid>:<path>` ref names, or undefined for any other ref. A
 * ref into the bridge's own repo is one of `kbDocs`.
 */
export function resolveRepoRef(kbDocs: KbDoc[], rc: NosediveRc, ref: string): KbDoc | undefined {
	const qualified = splitRepoRef(ref);
	if (!qualified) return undefined;
	const path = toPosixPath(qualified.path);
	if (qualified.repo === rc.bridge) {
		const builtin = /^kb\/([0-9a-f-]{36})\.md$/.exec(path)?.[1];
		const builtinPath = builtin && builtinDocPath(builtin);
		if (builtinPath) return readKbDoc(builtinPath, rc.bridgeDir);
		const doc = kbDocs.find((candidate) => candidate.relPath === path);
		if (!doc) throw new Error(`not found: ${ref} (no ${path} in the bridge)`);
		return doc;
	}
	if (!rc.bridge)
		throw new Error(`${ref} names another repo, which needs \`bridge:\` in the bridge config`);
	const repo = kbDocs.find((doc) => doc.id === qualified.repo && doc.kind === "repo");
	if (!repo) throw new Error(`no repo ${qualified.repo} in the bridge kb: ${ref}`);
	const doc = readRepoDoc(rc, repo, path, true);
	if (!doc) throw new Error(`not found: ${ref} (no ${path} in ${repo.name})`);
	return doc;
}

/** A doc may link into the bridge and its own repo, and into another only while it scopes it. */
export function mayLinkRepo(
	rc: NosediveRc,
	scopes: ScopeRef[],
	ownRepo: string | undefined,
	repoId: string,
): boolean {
	return (
		repoId === rc.bridge || repoId === ownRepo || scopes.some((scope) => scope.repoId === repoId)
	);
}

/**
 * The doc a link names, for a walk that crosses repos. A bare ref names the
 * nearest copy: the linking doc's own repo, then the bridge (`byId`). A
 * `<repo-quid>:<path>` ref is read from its repo when the linking doc may link
 * there. Nothing is fetched, so a repo never cached names nothing.
 */
export function linkedDoc(
	rc: NosediveRc,
	from: KbDoc,
	link: LinkRef,
	byId: Map<string, KbDoc>,
): KbDoc | undefined {
	const builtin = builtinDocPath(link.id);
	if (builtin) return readKbDoc(builtin, rc.bridgeDir);
	const fromRepo = from.home?.repoId ?? rc.bridge;
	const repoId = link.repo ?? fromRepo;
	if (!repoId || repoId === rc.bridge) return byId.get(link.id);
	if (link.repo && !mayLinkRepo(rc, from.scopes, fromRepo, repoId)) return undefined;
	const repo = byId.get(repoId);
	const path = link.repo ? splitRepoRef(link.target)!.path : `kb/${link.id}.md`;
	const doc = repo?.kind === "repo" ? readRepoDoc(rc, repo, path, false) : undefined;
	return doc ?? (link.repo ? undefined : byId.get(link.id));
}
