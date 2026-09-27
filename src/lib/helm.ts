import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { Marked } from "marked";

import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME, LEGACY_CONFIG_FILENAME } from "./constants.js";
import {
	configCompatibilityLevel,
	leadingMarkdownFrontmatter,
	parseYamlBlock,
	readNosediveRc,
	uuidLike,
	type NosediveRc,
} from "./coreParsing.js";
import { findDocs } from "./find.js";
import { gitOutput } from "./gitProcess.js";
import { helmPage } from "./helmPage.js";
import { loadKbDocs, type KbDoc } from "./kbDocs.js";
import { namespacedUuid } from "./namespacedUuid.js";
import { writeFileAtomic } from "./renderPlan.js";
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
	frontmatter: string;
	html: string;
	links: HelmLink[];
}

const CONFIG_PATHS = [`${BRIDGE_STATE_DIRNAME}/${BASE_CONFIG_FILENAME}`, LEGACY_CONFIG_FILENAME];
const DECK_TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

/**
 * The bridge config's `decks:` entries, as a comma string or a YAML list. With
 * none configured the backlog memo is the one deck, so a bridge that has never
 * heard of decks still shows its plan.
 */
export function parseHelmDecks(raw: unknown, backlog: string | undefined): string[] {
	const entries =
		raw === undefined || raw === null || raw === ""
			? []
			: (Array.isArray(raw) ? raw.map(String) : String(raw).split(",")).map((entry) =>
					entry.trim(),
				);
	for (const entry of entries) {
		if (!uuidLike(entry) && !DECK_TAG.test(entry))
			throw new Error(`invalid deck tag in decks: ${JSON.stringify(entry)} (use kebab-case)`);
	}
	if (entries.length > 0) return entries;
	return backlog ? [backlog] : [];
}

function configuredDecks(rc: NosediveRc): string[] {
	const config = parseYamlBlock(readFileSync(rc.path, "utf8"), rc.path);
	return parseHelmDecks(config.raw.decks, rc.backlog);
}

function deckId(rc: NosediveRc, entry: string): string {
	if (uuidLike(entry)) return entry.toLowerCase();
	if (!rc.bridge)
		throw new Error(`deck tag ${entry} needs the bridge config's \`bridge:\` repo id`);
	return namespacedUuid(rc.bridge, entry);
}

function renderDeckDoc(id: string, tag: string): string {
	return [
		"---",
		"kind: deck",
		`id: ${id}`,
		`name: ${tag}`,
		`gist: "Deck ${tag}"`,
		"---",
		"",
		`# ${tag.slice(0, 1).toUpperCase()}${tag.slice(1)}`,
		"",
	].join("\n");
}

/** Writes and commits a `kind: deck` doc for every configured tag that has none. */
export function ensureTagDecks(cwd: string, io: { log(message: string): void }): void {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("helm requires a configured kb directory");
	for (const entry of configuredDecks(rc)) {
		if (uuidLike(entry)) continue;
		const path = join(rc.kbDir, `${deckId(rc, entry)}.md`);
		if (existsSync(path)) continue;
		writeFileAtomic(path, renderDeckDoc(deckId(rc, entry), entry));
		commitBridgeDocs(rc.bridgeDir, `deck(${entry}): created`, [path], io);
	}
}

function bridgeDocs(cwd: string): { rc: NosediveRc; docs: KbDoc[] } {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("helm requires a configured kb directory");
	return { rc, docs: loadKbDocs(rc.kbDir, rc.bridgeDir) };
}

export function helmDecks(cwd: string): HelmDeck[] {
	const { rc, docs } = bridgeDocs(cwd);
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	return configuredDecks(rc).map((entry) => {
		const id = deckId(rc, entry);
		const doc = byId.get(id);
		if (!doc) return { id, name: entry, kind: "missing", gist: `no kb doc ${id}` };
		return { id, name: doc.name, kind: doc.kind, gist: doc.gist };
	});
}

/** The repos a deck reaches, as `find repo` lists them from it, in its scope order. */
export function helmDeckRepos(cwd: string, id: string): HelmRepoCard[] | undefined {
	const { rc, docs } = bridgeDocs(cwd);
	const deck = docs.find((doc) => doc.id === id);
	if (!deck) return undefined;
	const reached = findDocs(deck, docs, "repo", undefined, rc.bridgeDir, {
		scopeIds: new Set(),
		kinds: [],
	});
	const ordered = deck.scopes.map((scope) => scope.repoId);
	const rank = (repoId: string) => {
		const index = ordered.indexOf(repoId);
		return index === -1 ? ordered.length : index;
	};
	return reached
		.sort((a, b) => rank(a.id) - rank(b.id))
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

export function helmDoc(cwd: string, id: string): HelmDoc | undefined {
	const { docs } = bridgeDocs(cwd);
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
		frontmatter: block?.yaml ?? "",
		html: markdown.parse(block?.body ?? text, { async: false }),
		links,
	};
}

export interface HelmServer {
	url: string;
	close(): Promise<void>;
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
	res.writeHead(status, {
		"content-type": `${type}; charset=utf-8`,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(body);
}

function sendJson(res: ServerResponse, value: unknown): void {
	if (value === undefined)
		return send(res, 404, "application/json", JSON.stringify({ error: "not found" }));
	send(res, 200, "application/json", JSON.stringify(value));
}

function sameToken(given: string | null | undefined, token: string): boolean {
	if (!given || given.length !== token.length) return false;
	return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/**
 * Loopback only, and every request must carry the per-launch token and name
 * the bound address as its Host: helm writes files and pushes, so a page on
 * any other site must not be able to drive it, DNS rebinding included.
 */
export async function startHelmServer(
	cwd: string,
	io: { log(message: string): void },
	port = 0,
): Promise<HelmServer> {
	ensureTagDecks(cwd, io);
	const token = randomBytes(16).toString("hex");
	let allowedHost = "";

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.headers.host !== allowedHost) return send(res, 403, "text/plain", "forbidden host\n");
		const url = new URL(req.url ?? "/", `http://${allowedHost}`);
		if (req.method === "GET" && url.pathname === "/") {
			if (!sameToken(url.searchParams.get("token"), token))
				return send(res, 403, "text/plain", "missing or wrong token\n");
			return send(res, 200, "text/html", helmPage);
		}
		const header = req.headers["x-helm-token"];
		if (!sameToken(Array.isArray(header) ? header[0] : header, token))
			return send(res, 403, "application/json", JSON.stringify({ error: "forbidden" }));
		const id = url.searchParams.get("id") ?? "";
		try {
			if (req.method !== "GET") return sendJson(res, undefined);
			if (url.pathname === "/api/decks") return sendJson(res, helmDecks(cwd));
			if (url.pathname === "/api/deck-repos") return sendJson(res, helmDeckRepos(cwd, id));
			if (url.pathname === "/api/doc") return sendJson(res, helmDoc(cwd, id));
			return sendJson(res, undefined);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return send(res, 500, "application/json", JSON.stringify({ error: message }));
		}
	});

	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolveListen());
	});
	const bound = (server.address() as AddressInfo).port;
	allowedHost = `127.0.0.1:${bound}`;
	return {
		url: `http://${allowedHost}/?token=${token}`,
		close: () =>
			new Promise((resolveClose) => {
				server.close(() => resolveClose());
				// An open browser tab holds keep-alive sockets that would stall close.
				server.closeAllConnections();
			}),
	};
}
