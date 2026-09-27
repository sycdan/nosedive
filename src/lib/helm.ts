import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME, LEGACY_CONFIG_FILENAME } from "./constants.js";
import { configCompatibilityLevel, parseYamlBlock, readNosediveRc } from "./coreParsing.js";
import { findDocs } from "./find.js";
import { gitOutput } from "./gitProcess.js";
import { helmPage } from "./helmPage.js";
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

export interface HelmBoard {
	repos: HelmRepoCard[];
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

/** The bridge first, then every repo the backlog reaches, as `find repo` lists them. */
export function helmBoard(cwd: string): HelmBoard {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("helm requires a configured kb directory");
	const docs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const bridgeDoc = rc.bridge ? docs.find((doc) => doc.id === rc.bridge) : undefined;
	const backlog = rc.backlog ? docs.find((doc) => doc.id === rc.backlog) : undefined;
	const reached = backlog
		? findDocs(backlog, docs, "repo", undefined, rc.bridgeDir, { scopeIds: new Set(), kinds: [] })
		: [];
	const ordered = backlog ? backlog.scopes.map((scope) => scope.repoId) : [];
	reached.sort((a, b) => rank(ordered, a.id) - rank(ordered, b.id));
	const repos = reached
		.filter((doc) => doc.id !== bridgeDoc?.id)
		.map((doc) => repoCard(doc, rc.bridgeDir, false));
	if (bridgeDoc) repos.unshift(repoCard(bridgeDoc, rc.bridgeDir, true));
	return { repos };
}

function rank(ordered: string[], id: string): number {
	const index = ordered.indexOf(id);
	return index === -1 ? ordered.length : index;
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

function sameToken(given: string | null | undefined, token: string): boolean {
	if (!given || given.length !== token.length) return false;
	return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/**
 * Loopback only, and every request must carry the per-launch token and name
 * the bound address as its Host: helm writes files and pushes, so a page on
 * any other site must not be able to drive it, DNS rebinding included.
 */
export async function startHelmServer(cwd: string, port = 0): Promise<HelmServer> {
	readNosediveRc(cwd);
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
		try {
			if (req.method === "GET" && url.pathname === "/api/board")
				return send(res, 200, "application/json", JSON.stringify(helmBoard(cwd)));
			return send(res, 404, "application/json", JSON.stringify({ error: "not found" }));
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
