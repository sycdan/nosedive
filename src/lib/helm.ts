import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Marked } from "marked";

import { configuredDecks } from "./decks.js";
import { inheritedScopes } from "./diveScopes.js";
import { kindSources, loadKinds, repoKbDir, type KindSource } from "./kinds.js";
import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME, LEGACY_CONFIG_FILENAME } from "./constants.js";
import {
	configCompatibilityLevel,
	leadingMarkdownFrontmatter,
	parseYamlBlock,
	readNosediveRc,
	type NosediveRc,
} from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { loadKbDocs, type KbDoc } from "./kbDocs.js";
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

export interface HelmDeck {
	id: string;
	name: string;
	kind: string;
	gist: string;
}

export type HelmLink =
	| {
			type: "doc";
			target: string;
			rel?: string;
			id: string;
			name: string;
			kind: string;
			gist: string;
	  }
	| { type: "url" | "file"; target: string; rel?: string };

export interface HelmDoc {
	id: string;
	kind: string;
	name: string;
	gist: string;
	meta: Record<string, unknown>;
	frontmatter: string;
	html: string;
	links: HelmLink[];
}

const CONFIG_PATHS = [`${BRIDGE_STATE_DIRNAME}/${BASE_CONFIG_FILENAME}`, LEGACY_CONFIG_FILENAME];
const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i;

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

function bridgeDocs(cwd: string): { rc: NosediveRc; docs: KbDoc[] } {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("helm requires a configured kb directory");
	return { rc, docs: loadKbDocs(rc.kbDir, rc.bridgeDir) };
}

/** The bridge helm serves -- the root of the breadcrumb -- and its decks in config order. */
export function helmDecks(cwd: string): {
	bridge: { id?: string; name: string };
	decks: HelmDeck[];
} {
	const { rc, docs } = bridgeDocs(cwd);
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const bridgeDoc = rc.bridge ? byId.get(rc.bridge) : undefined;
	const decks = configuredDecks(rc).map((id) => {
		const doc = byId.get(id);
		if (!doc) return { id, name: id, kind: "missing", gist: `no kb doc ${id}` };
		return { id, name: doc.name, kind: doc.kind, gist: doc.gist };
	});
	return { bridge: { id: rc.bridge, name: bridgeDoc?.name ?? basename(rc.bridgeDir) }, decks };
}

/** The repos a deck scopes, in its scope order; links are not followed. */
export function helmDeckRepos(cwd: string, id: string): HelmRepoCard[] | undefined {
	const { rc, docs } = bridgeDocs(cwd);
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const deck = byId.get(id);
	if (!deck) return undefined;
	return deck.scopes
		.map((scope) => byId.get(scope.repoId))
		.filter((doc): doc is KbDoc => doc?.kind === "repo")
		.map((doc) => repoCard(doc, rc.bridgeDir, doc.id === rc.bridge));
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
function readableSource(rc: NosediveRc, repo: KbDoc): KindSource | undefined {
	if (repo.id === rc.bridge)
		return { id: repo.id, name: repo.name, root: rc.bridgeDir, kbDir: rc.kbDir! };
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

/** The ids of the repos crud can write to right now, or none when it cannot tell. */
export function crudReach(cwd: string): Set<string | undefined> {
	try {
		return new Set(kindSources(cwd).map((source) => source.id));
	} catch {
		return new Set();
	}
}

export interface HelmContext {
	repos: Array<HelmRepoCard & { inCrudContext: boolean }>;
	kinds: Array<{
		id: string;
		name: string;
		gist: string;
		repoId?: string;
		repoName: string;
		count: number;
		inCrudContext: boolean;
	}>;
	unreadable: string[];
}

/**
 * What is in view under a deck: its scoped repos -- a feat's instead, when one
 * is selected, inherited from its nearest scoped ancestor -- and the kinds
 * their kbs declare, narrowed to one repo when one is selected. Each says
 * whether crud can reach it, because helm writes only through crud.
 */
export function helmContext(
	cwd: string,
	deckId: string,
	featId?: string,
	repoId?: string,
	diveId?: string,
): HelmContext | undefined {
	const { rc, docs } = bridgeDocs(cwd);
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const deck = byId.get(deckId);
	if (!deck) return undefined;
	const feat = featId ? byId.get(featId) : undefined;
	if (featId && !feat) return undefined;
	// A staged or active dive narrows furthest: its scopes are what it will work on.
	const dive = diveId ? byId.get(diveId) : undefined;
	const scopes = dive ? dive.scopes : feat ? inheritedScopes(feat, docs).scopes : deck.scopes;
	const inView = scopes
		.map((scope) => byId.get(scope.repoId))
		.filter((doc): doc is KbDoc => doc?.kind === "repo");
	const reach = crudReach(cwd);
	const repos = inView.map((doc) => ({
		...repoCard(doc, rc.bridgeDir, doc.id === rc.bridge),
		inCrudContext: reach.has(doc.id),
	}));
	const sources: KindSource[] = [];
	const unreadable: string[] = [];
	for (const doc of inView.filter((repo) => !repoId || repo.id === repoId)) {
		const source = readableSource(rc, doc);
		if (source) sources.push(source);
		else unreadable.push(doc.name);
	}
	const counts = new Map(sources.map((source) => [source.id, kindCounts(source.kbDir)]));
	const kinds = loadKinds(sources).map((kind) => ({
		id: kind.id,
		name: kind.name,
		gist: kind.gist,
		repoId: kind.source.id,
		repoName: kind.source.name,
		count: counts.get(kind.source.id)?.get(kind.name) ?? 0,
		inCrudContext: reach.has(kind.source.id),
	}));
	return { repos, kinds, unreadable };
}

/** The docs of one kind in one repo's kb. */
export function helmKindDocs(
	cwd: string,
	repoId: string,
	kind: string,
): Array<{ id: string; name: string; gist: string }> | undefined {
	const { rc, docs } = bridgeDocs(cwd);
	const repo = docs.find((doc) => doc.id === repoId && doc.kind === "repo");
	const source = repo ? readableSource(rc, repo) : undefined;
	if (!source) return undefined;
	return loadKbDocs(source.kbDir, source.root)
		.filter((doc) => doc.kind === kind)
		.map((doc) => ({ id: doc.id, name: doc.name, gist: doc.gist }));
}

/** A doc from the bridge kb, or from a repo in view's kb when `repoId` names one. */
export function helmDoc(cwd: string, id: string, repoId?: string): HelmDoc | undefined {
	const { rc, docs: bridgeKb } = bridgeDocs(cwd);
	let docs = bridgeKb;
	if (repoId && repoId !== rc.bridge) {
		const repo = bridgeKb.find((doc) => doc.id === repoId && doc.kind === "repo");
		const source = repo ? readableSource(rc, repo) : undefined;
		if (!source) return undefined;
		docs = loadKbDocs(source.kbDir, source.root);
	}
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const doc = byId.get(id);
	if (!doc) return undefined;
	const text = readFileSync(doc.path, "utf8");
	const block = leadingMarkdownFrontmatter(text);
	const links = doc.links.map((link): HelmLink => {
		const target = byId.get(link.id);
		if (target)
			return {
				type: "doc",
				target: link.target,
				rel: link.rel,
				id: target.id,
				name: target.name,
				kind: target.kind,
				gist: target.gist,
			};
		return {
			type: URL_TARGET.test(link.target) ? "url" : "file",
			target: link.target,
			rel: link.rel,
		};
	});
	return {
		id: doc.id,
		kind: doc.kind,
		name: doc.name,
		gist: doc.gist,
		meta: doc.metaRaw,
		frontmatter: block?.yaml ?? "",
		html: markdown.parse(block?.body ?? text, { async: false }),
		links,
	};
}
