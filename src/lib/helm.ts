import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, join } from "node:path";

import { Marked } from "marked";

import { configuredDecks } from "./decks.js";
import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME, LEGACY_CONFIG_FILENAME } from "./constants.js";
import {
	configCompatibilityLevel,
	leadingMarkdownFrontmatter,
	parseYamlBlock,
	readNosediveRc,
	type NosediveRc,
} from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { helmPage } from "./helmPage.js";
import { loadKbDocs, type KbDoc } from "./kbDocs.js";
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

const PORT_BASE = 20000;
const PORT_SPAN = 10000;
const PORT_TRIES = 10;

/**
 * Ports of the bridge's own, in the order helm tries them, so each bridge's
 * helm comes back where its tabs expect it. The first is usually free; the rest
 * cover a port the OS holds without any process owning it. All sit below
 * 32768, where Linux starts handing out ephemeral ports -- which WSL's mirrored
 * networking reserves on the Windows side too, in blocks no process shows as
 * owning -- and so below Windows' own range from 49152.
 */
export function helmPorts(rc: NosediveRc): number[] {
	const digest = createHash("sha1")
		.update(rc.bridge ?? rc.bridgeDir)
		.digest();
	const first = digest.readUInt32BE(0) % PORT_SPAN;
	return Array.from(
		{ length: PORT_TRIES },
		(_, index) => PORT_BASE + ((first + index) % PORT_SPAN),
	);
}

function helmUrl(port: number, token: string): string {
	return `http://127.0.0.1:${port}/?token=${token}`;
}

async function answersAsHelm(port: number, token: string): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/decks`, {
			headers: { "x-helm-token": token },
			signal: AbortSignal.timeout(2000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<boolean> {
	return new Promise((resolveListen, reject) => {
		const onError = (err: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			if (err.code === "EADDRINUSE" || err.code === "EACCES") resolveListen(false);
			else reject(err);
		};
		const onListening = () => {
			server.off("error", onError);
			resolveListen(true);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});
}

/**
 * Kept across launches so a tab left open survives a restart. It lives in the
 * managed cache, which the bridge never commits.
 */
function helmToken(rc: NosediveRc): string {
	const path = managedCachePath("helm-token", rc.bridgeDir);
	if (existsSync(path)) {
		const saved = readFileSync(path, "utf8").trim();
		if (/^[0-9a-f]{32}$/.test(saved)) return saved;
	}
	const token = randomBytes(16).toString("hex");
	mkdirSync(dirname(path), { recursive: true });
	writeFileAtomic(path, `${token}\n`);
	return token;
}

/**
 * Loopback only, and every request must carry the bridge's helm token and name
 * the bound address as its Host: helm writes files and pushes, so a page on
 * any other site must not be able to drive it, DNS rebinding included.
 */
export async function startHelmServer(cwd: string): Promise<HelmServer> {
	const rc = readNosediveRc(cwd);
	const token = helmToken(rc);
	// Changes on every launch; an open page that sees a new one reloads itself.
	const boot = randomBytes(8).toString("hex");
	let allowedHost = "";

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		if (req.headers.host !== allowedHost) return send(res, 403, "text/plain", "forbidden host\n");
		const url = new URL(req.url ?? "/", `http://${allowedHost}`);
		if (req.method === "GET" && url.pathname === "/") {
			if (!sameToken(url.searchParams.get("token"), token))
				return send(res, 403, "text/plain", "missing or wrong token\n");
			return send(res, 200, "text/html", helmPage);
		}
		// EventSource cannot send headers, so the stream takes its token in the query.
		if (req.method === "GET" && url.pathname === "/api/events") {
			if (!sameToken(url.searchParams.get("token"), token))
				return send(res, 403, "text/plain", "missing or wrong token\n");
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
			});
			res.write(`retry: 500\nevent: boot\ndata: ${boot}\n\n`);
			return;
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

	const ports = helmPorts(rc);
	let listening = false;
	// Only a helm holding this bridge's token answers. Every port is asked
	// first, because a running helm may sit past a port that has since freed.
	for (const port of ports) {
		if (await answersAsHelm(port, token))
			throw new Error(`helm is already running for this bridge: ${helmUrl(port, token)}`);
	}
	for (const port of ports) if ((listening = await listen(server, port))) break;
	if (!listening)
		throw new Error(`helm could not bind any of its ports for this bridge: ${ports.join(", ")}`);
	const bound = (server.address() as AddressInfo).port;
	allowedHost = `127.0.0.1:${bound}`;
	return {
		url: helmUrl(bound, token),
		close: () =>
			new Promise((resolveClose) => {
				server.close(() => resolveClose());
				// An open browser tab holds keep-alive sockets that would stall close.
				server.closeAllConnections();
			}),
	};
}
