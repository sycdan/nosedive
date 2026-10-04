import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Marked } from "marked";

import { instanceFailures, type InstanceFailure } from "./kindInstances.js";
import { isZerostar, kindSources, loadKinds, repoKbDir, type KindSource } from "./kinds.js";
import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME, LEGACY_CONFIG_FILENAME } from "./constants.js";
import {
	configCompatibilityLevel,
	leadingMarkdownFrontmatter,
	parseYamlBlock,
	readNosediveRc,
	type NosediveRc,
} from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { isJumpable, rootedScopes } from "./jumpable.js";
import { loadKbDocs, readActiveDiveId, type KbDoc } from "./kbDocs.js";
import { helmDocText, helmLink, helmRepoDoc, type HelmLink } from "./helmLinks.js";
import { bridgeView, type BridgeView } from "./helmView.js";
import { managedCachePath } from "./repoWorkspaceCore.js";
import { expectedWorktreePath } from "./repoWorktrees.js";

export interface HelmRepoCard {
	id: string;
	name: string;
	gist: string;
	icon: string | null;
	isBridge: boolean;
	trunk: string;
	/** Null when the repo has no checkout in the workspace. */
	hydrated: { path: string; commit: string; atTrunk: boolean } | null;
	/** Null when not installed; "unknown" when trunk has never been fetched. */
	nosedive: { level: number } | null | "unknown";
}

export type { HelmLink };

export interface HelmDoc {
	id: string;
	/** What crud and jump take: the id, or `<repo-quid>:<path>` for a doc in another repo. */
	ref: string;
	kind: string;
	name: string;
	gist: string;
	title?: string;
	meta: Record<string, unknown>;
	frontmatter: string;
	html: string;
	links: HelmLink[];
	/** Whether `jump` takes it as a feat: reached from the backlog memo through `.feat` links. */
	jumpable: boolean;
}

const CONFIG_PATHS = [`${BRIDGE_STATE_DIRNAME}/${BASE_CONFIG_FILENAME}`, LEGACY_CONFIG_FILENAME];

function levelFromConfig(text: string, label: string): { level: number } | null {
	try {
		return { level: configCompatibilityLevel(parseYamlBlock(text, label), label) };
	} catch {
		return null;
	}
}

function installedInCheckout(root: string): { level: number } | null {
	for (const rel of CONFIG_PATHS) {
		const path = join(root, rel);
		if (existsSync(path)) return levelFromConfig(readFileSync(path, "utf8"), path);
	}
	return null;
}

function installedOnTrunk(cachePath: string, trunk: string): { level: number } | null {
	for (const rel of CONFIG_PATHS) {
		const text = gitOutput(cachePath, ["show", `refs/remotes/origin/${trunk}:${rel}`]);
		if (text !== undefined) return levelFromConfig(text, `${trunk}:${rel}`);
	}
	return null;
}

function hydratedState(root: string, repoId: string, trunk: string, isBridge: boolean) {
	if (!isBridge) {
		const marker = join(root, ".nosedive-ref");
		if (!existsSync(marker) || !readFileSync(marker, "utf8").includes(repoId)) return null;
	}
	const commit = gitOutput(root, ["rev-parse", "HEAD"]);
	if (!commit) return null;
	const trunkTip = gitOutput(root, ["rev-parse", `refs/remotes/origin/${trunk}`]);
	return { path: root, commit, atTrunk: trunkTip === commit };
}

function repoCard(doc: KbDoc, bridgeDir: string, isBridge: boolean): HelmRepoCard {
	const trunk = doc.repoBaseBranch ?? doc.metaScalars.trunk ?? "main";
	const root = isBridge ? bridgeDir : expectedWorktreePath(doc, bridgeDir);
	const hydrated = hydratedState(root, doc.id, trunk, isBridge);
	const cache = managedCachePath(doc.id, bridgeDir);
	const nosedive = hydrated
		? installedInCheckout(root)
		: existsSync(cache)
			? installedOnTrunk(cache, trunk)
			: "unknown";
	return {
		id: doc.id,
		name: doc.name,
		gist: doc.gist,
		icon: doc.metaScalars.icon || null,
		isBridge,
		trunk,
		hydrated,
		nosedive,
	};
}

function bridgeDocs(cwd: string): BridgeView {
	return bridgeView(cwd);
}

function escapeHtml(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
	);
}

// Doc bodies come from any repo in the workspace; raw HTML in them is shown,
// never run, because the page holds a token that can drive the bridge.
const markdown = new Marked({ renderer: { html: ({ text }) => escapeHtml(text) } });

/**
 * Where a repo in view keeps its kb, when it can be read: the bridge always,
 * any other repo only while it is hydrated.
 */
function readableSource(view: BridgeView, repo: KbDoc): KindSource | undefined {
	const { rc } = view;
	if (repo.id === rc.bridge)
		return view.self
			? { id: repo.id, name: repo.name, root: view.self.root, kbDir: view.self.kbDir }
			: { id: repo.id, name: repo.name, root: rc.bridgeDir, kbDir: rc.kbDir! };
	const trunk = repo.repoBaseBranch ?? "main";
	const root = expectedWorktreePath(repo, rc.bridgeDir);
	if (!hydratedState(root, repo.id, trunk, false)) return undefined;
	return { id: repo.id, name: repo.name, root, kbDir: repoKbDir(root) };
}

/** How many docs of each kind a kb holds, from each doc's `kind:` line. */
function kindCounts(kbDir: string): Map<string, number> {
	const counts = new Map<string, number>();
	if (!existsSync(kbDir)) return counts;
	for (const file of readdirSync(kbDir).filter((name) => name.endsWith(".md"))) {
		const kind = /^kind: (\S+)\s*$/m.exec(readFileSync(join(kbDir, file), "utf8"))?.[1];
		if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return counts;
}

/**
 * The ids of the repos helm may write to through crud: the active dive's
 * scopes. With no dive, none -- helm writes only on a dive (a note aside) --
 * and none when it cannot tell.
 */
export function crudReach(cwd: string): Set<string | undefined> {
	try {
		if (!readActiveDiveId(readNosediveRc(cwd).workspaceDir)) return new Set();
		return new Set(kindSources(cwd).map((source) => source.id));
	} catch {
		return new Set();
	}
}

export interface HelmContext {
	repos: Array<HelmRepoCard & { inScope: boolean; inCrudContext: boolean }>;
	kinds: Array<{
		id: string;
		name: string;
		gist: string;
		repoId?: string;
		repoName: string;
		inCrudContext: boolean;
	}>;
	unreadable: string[];
}

/**
 * Every repo the bridge knows, those in scope under a root first -- its
 * scoped repos, a feat's instead when one is selected, scoped the way a dive
 * under it would be -- and the kinds the in-scope kbs declare, narrowed to one
 * repo when one is selected. Each says whether crud can reach it, because
 * helm writes only through crud. Counts are helmKindCounts', apart.
 */
export function helmContext(
	cwd: string,
	rootId: string,
	featId?: string,
	repoId?: string,
	diveId?: string,
): HelmContext | undefined {
	const view = bridgeDocs(cwd);
	const { rc, docs } = view;
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const root = byId.get(rootId) ?? helmRepoDoc(view, rootId);
	if (!root) return undefined;
	const feat = featId ? (byId.get(featId) ?? helmRepoDoc(view, featId)) : undefined;
	if (featId && !feat) return undefined;
	// A staged or active dive narrows furthest: its scopes are what it will work on.
	const dive = diveId ? byId.get(diveId) : undefined;
	const scopes = dive ? dive.scopes : rootedScopes(rc, docs, feat ?? root).all;
	const inView = scopes
		.map((scope) => byId.get(scope.repoId))
		.filter((doc): doc is KbDoc => doc?.kind === "repo");
	const reach = crudReach(cwd);
	const inScope = new Set(inView.map((doc) => doc.id));
	const outOfScope = docs
		.filter((doc) => doc.kind === "repo" && !inScope.has(doc.id))
		.sort((a, b) => a.name.localeCompare(b.name));
	const repos = [...inView, ...outOfScope].map((doc) => ({
		...repoCard(doc, rc.bridgeDir, doc.id === rc.bridge),
		inScope: inScope.has(doc.id),
		inCrudContext: reach.has(doc.id),
	}));
	const sources: KindSource[] = [];
	const unreadable: string[] = [];
	for (const doc of inView.filter((repo) => !repoId || repo.id === repoId)) {
		const source = readableSource(view, doc);
		if (source) sources.push(source);
		else unreadable.push(doc.name);
	}
	const kinds = loadKinds(sources).map((kind) => ({
		id: kind.id,
		name: kind.name,
		gist: kind.gist,
		repoId: kind.source.id,
		repoName: kind.source.name,
		inCrudContext: reach.has(kind.source.id),
	}));
	return { repos, kinds, unreadable };
}

/**
 * How many docs of each kind the named repos' kbs hold, by repo id; a repo
 * whose kb cannot be read is left out. Apart from helmContext because it reads
 * every doc, which a big kb makes slow.
 */
export function helmKindCounts(
	cwd: string,
	repoIds: string[],
): Record<string, Record<string, number>> {
	const view = bridgeDocs(cwd);
	const counts: Record<string, Record<string, number>> = {};
	for (const repo of view.docs.filter((doc) => doc.kind === "repo" && repoIds.includes(doc.id))) {
		const source = readableSource(view, repo);
		if (source) counts[repo.id] = Object.fromEntries(kindCounts(source.kbDir));
	}
	return counts;
}

/**
 * Which docs of a kind a proposed schema would reject, before it is saved:
 * the breakage a schema edit costs, shown while it can still be reconsidered.
 */
export function helmKindCheck(
	cwd: string,
	repoId: string,
	kindId: string,
	schema: unknown,
): { failures: InstanceFailure[] } | undefined {
	const view = bridgeDocs(cwd);
	const repo = view.docs.find((doc) => doc.id === repoId && doc.kind === "repo");
	const source = repo ? readableSource(view, repo) : undefined;
	const kind = source
		? loadKinds([source]).find((candidate) => candidate.id === kindId)
		: undefined;
	if (!kind) return undefined;
	return { failures: instanceFailures({ ...kind, meta: { ...kind.meta, schema } }) };
}

/** The docs of one kind in one repo's kb. */
export function helmKindDocs(
	cwd: string,
	repoId: string,
	kind: string,
): Array<{ id: string; name: string; gist: string }> | undefined {
	const view = bridgeDocs(cwd);
	const repo = view.docs.find((doc) => doc.id === repoId && doc.kind === "repo");
	const source = repo ? readableSource(view, repo) : undefined;
	if (!source) return undefined;
	return loadKbDocs(source.kbDir, source.root)
		.filter((doc) => doc.kind === kind)
		.map((doc) => ({ id: doc.id, name: doc.name, gist: doc.gist }));
}

/** Whether helm offers Jump on a doc: what `jump <doc>` would accept. A bridge with no backlog memo offers none. */
function jumpableInHelm(rc: NosediveRc, kb: KbDoc[], doc: KbDoc, repoId?: string): boolean {
	if (doc.kind === "dive" || doc.kind === "repo") return false;
	if (!repoId && doc.id === rc.backlog) return false;
	try {
		return isJumpable(rc, kb, doc, repoId);
	} catch {
		return false;
	}
}

/**
 * A doc from the bridge kb, or from another repo's when `repoId` names one: its
 * checkout's kb while hydrated, else the doc alone from the managed cache.
 */
export function helmDoc(cwd: string, id: string, repoId?: string): HelmDoc | undefined {
	const view = bridgeDocs(cwd);
	const { rc, docs: bridgeKb } = view;
	let docs = bridgeKb;
	if (repoId && repoId !== rc.bridge) {
		const repo = bridgeKb.find((doc) => doc.id === repoId && doc.kind === "repo");
		const source = repo ? readableSource(view, repo) : undefined;
		const cached = repo && !source ? helmRepoDoc(view, `${repoId}:kb/${id}.md`) : undefined;
		if (!source && !cached) return undefined;
		docs = source ? loadKbDocs(source.kbDir, source.root) : [cached!];
	}
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	// A repo that takes a shipped kind reads it from the bridge.
	const doc =
		byId.get(id) ??
		(isZerostar(id) ? bridgeKb.find((d) => d.id === id && d.kind === "kind") : undefined);
	if (!doc) return undefined;
	const text = helmDocText(view, doc);
	const block = leadingMarkdownFrontmatter(text);
	const home = repoId ?? rc.bridge;
	const links = doc.links.map((link) => helmLink(view, doc, home, byId, link));
	return {
		id: doc.id,
		ref: home === rc.bridge || doc.kind === "kind" ? doc.id : `${home}:${doc.relPath}`,
		kind: doc.kind,
		name: doc.name,
		gist: doc.gist,
		title: doc.h1,
		meta: doc.metaRaw,
		frontmatter: block?.yaml ?? "",
		html: markdown.parse(block?.body ?? text, { async: false }),
		links,
		jumpable: jumpableInHelm(rc, bridgeKb, doc, home === rc.bridge ? undefined : home),
	};
}
