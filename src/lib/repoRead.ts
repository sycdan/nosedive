import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
	leadingMarkdownFrontmatter,
	toPosixPath,
	uuidLike,
	type NosediveRc,
} from "./coreParsing.js";
import { runGit } from "./gitProcess.js";
import {
	loadKbDocs,
	readActiveDiveId,
	readKbDoc,
	readKbDocById,
	type KbDoc,
	type ScopeRef,
} from "./kbDocs.js";
import { repoCheckout } from "./repoLinks.js";
import { ensureManagedRepoCache, managedCachePath } from "./repoWorkspaceCore.js";
import { maybeFetchSource } from "./repoWorktrees.js";

/** A managed cache fetched this recently is read as it is. */
const FRESH_MS = 60_000;

const oneLine = (text: string) =>
	text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.join("; ");

/** The scopes a read asks with when no doc asks: the active dive's, or none. */
export function activeDiveScopes(rc: NosediveRc): ScopeRef[] {
	const id = readActiveDiveId(rc.workspaceDir);
	return (id && rc.kbDir && readKbDocById(rc.kbDir, rc.bridgeDir, id)?.scopes) || [];
}

/** The managed cache, cloned when there is none and fetched when it is stale. */
function freshCache(rc: NosediveRc, repo: KbDoc): string {
	const cache = managedCachePath(repo.id, rc.bridgeDir);
	try {
		if (!existsSync(cache)) ensureManagedRepoCache(repo, rc.bridgeDir);
		const fetched = join(cache, "FETCH_HEAD");
		if (!existsSync(fetched) || Date.now() - statSync(fetched).mtimeMs > FRESH_MS)
			maybeFetchSource(cache, repo.id);
	} catch (error) {
		throw new Error(oneLine(error instanceof Error ? error.message : String(error)));
	}
	return cache;
}

/** The scope's work branch for `repo` when origin has it, else trunk. */
function readBranch(cache: string, repo: KbDoc, scopes: ScopeRef[]): string {
	const branch = scopes.find((scope) => scope.repoId === repo.id)?.workBranch;
	const known = (name: string) =>
		runGit(cache, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]).status === 0;
	return branch && known(branch) ? branch : (repo.repoBaseBranch ?? "main");
}

/**
 * A doc in a repo other than the bridge, whole, the way `crud <repo>:<path>`
 * prints it: from the repo's hydrated checkout, else from its managed cache
 * at the branch `scopes` names for it, else at trunk. Nothing is hydrated.
 * Throws a one-line reason for a doc that is not there or has no frontmatter.
 */
export function readRepoText(
	rc: NosediveRc,
	repo: KbDoc,
	path: string,
	scopes: ScopeRef[] = activeDiveScopes(rc),
): { text: string; checkout?: string } {
	const checkout = repoCheckout(rc, repo);
	let text: string | undefined;
	let where = repo.name;
	if (checkout) {
		const file = join(checkout, path);
		if (existsSync(file) && statSync(file).isFile()) text = readFileSync(file, "utf8");
	} else {
		const cache = freshCache(rc, repo);
		const branch = readBranch(cache, repo, scopes);
		where = `${repo.name} at ${branch}`;
		const shown = runGit(cache, ["show", `refs/remotes/origin/${branch}:${toPosixPath(path)}`]);
		if (shown.status === 0) text = shown.stdout;
	}
	if (text === undefined) throw new Error(`no ${path} in ${where}`);
	if (!leadingMarkdownFrontmatter(text)) throw new Error(`${path} in ${where} has no frontmatter`);
	return { text, checkout };
}

/** `readRepoText`'s doc, parsed and carrying where it came from. */
export function readRepoRefDoc(
	rc: NosediveRc,
	repo: KbDoc,
	path: string,
	scopes?: ScopeRef[],
): KbDoc | undefined {
	// A link back names the bridge by its repo id, so a bridge without one cannot make one.
	if (!rc.bridge) return undefined;
	const { text, checkout } = readRepoText(rc, repo, path, scopes);
	const root = checkout ?? managedCachePath(repo.id, rc.bridgeDir);
	const doc = readKbDoc(join(root, path), root, text);
	return { ...doc, home: { repoId: repo.id, bridgeId: rc.bridge, checkout } };
}

/**
 * What `crud <repo>:<ref>` prints when `<repo>` is a repo crud reads rather
 * than one in play: a path in any repo the bridge kb knows, or a quid in one
 * other than the bridge that the active dive does not scope. Undefined leaves the ref to crud's own
 * lookup in the repos in play.
 */
export function readQualifiedRef(rc: NosediveRc, repoRef: string, ref: string): string | undefined {
	const quid = uuidLike(ref);
	if (!quid && !ref.includes("/") && !ref.endsWith(".md")) return undefined;
	const repos = rc.kbDir ? loadKbDocs(rc.kbDir, rc.bridgeDir) : [];
	const repo = repos.find(
		(doc) => doc.kind === "repo" && (doc.id === repoRef.toLowerCase() || doc.name === repoRef),
	);
	const inPlay = (id: string) =>
		id === rc.bridge || activeDiveScopes(rc).some((scope) => scope.repoId === id);
	if (quid && (!repo || inPlay(repo.id))) return undefined;
	if (!repo) throw new Error(`no repo ${repoRef} in the bridge kb`);
	const path = quid ? `kb/${ref.toLowerCase()}.md` : ref;
	if (repo.id !== rc.bridge) return readRepoText(rc, repo, path).text;
	const file = join(rc.bridgeDir, path);
	if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`no ${path} in the bridge`);
	const text = readFileSync(file, "utf8");
	if (!leadingMarkdownFrontmatter(text))
		throw new Error(`${path} in the bridge has no frontmatter`);
	return text;
}
