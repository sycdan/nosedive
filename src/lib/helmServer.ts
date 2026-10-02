import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

import { readNosediveRc, type NosediveRc } from "./coreParsing.js";
import { helmContext, helmDoc, helmKindCheck, helmKindDocs, helmRootRepos } from "./helm.js";
import { HELM_POLL_MS, helmInternals, helmLogFollower } from "./helmInternals.js";
import { helmPage } from "./helmPage.js";
import { gitOutput } from "./gitProcess.js";
import { isPrimaryWorktree } from "./helmBranch.js";
import { helmCreatableKinds } from "./helmCreate.js";
import { helmRepoList, helmRoots } from "./helmRoot.js";
import { helmDives } from "./helmDives.js";
import { pruneHelmLogs } from "./helmLog.js";
import { helmState } from "./helmState.js";
import { streamVerb } from "./helmRun.js";
import { helmBranches, helmMerge } from "./helmBranches.js";
import { helmPull, helmPush, helmSquash, helmUnpushed } from "./helmSync.js";
import { helmWrite, HelmRequestError, readJsonBody } from "./helmWrites.js";
import { writeFileAtomic } from "./renderPlan.js";
import { managedCachePath } from "./repoWorkspaceCore.js";

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
	// A branch worktree of the bridge shares its id, so its branch tells them apart;
	// the bridge's own checkout keeps the ports it always had.
	const id = rc.bridge ?? rc.bridgeDir;
	const key = isPrimaryWorktree(rc.bridgeDir)
		? id
		: `${id}:${gitOutput(rc.bridgeDir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? rc.bridgeDir}`;
	const digest = createHash("sha1").update(key).digest();
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
		const res = await fetch(`http://127.0.0.1:${port}/api/roots`, {
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
	pruneHelmLogs(cwd, new Date());
	// Changes on every launch; an open page that sees a new one reloads itself.
	const boot = randomBytes(8).toString("hex");
	let allowedHost = "";
	// Open event streams; while any is, the bridge state is polled and each
	// change is pushed to them, so a page follows dives and commits made outside it.
	const streams = new Set<ServerResponse>();
	let lastState: string | undefined;
	// When the poll last saw the state change, for the Internals view.
	let lastChangeAt: number | null = null;
	const nextLog = helmLogFollower(cwd);
	const readState = (): string | undefined => {
		try {
			return JSON.stringify(helmState(cwd));
		} catch {
			return undefined;
		}
	};
	const poll = setInterval(() => {
		if (!streams.size) return;
		const state = readState();
		const at = Date.now();
		let events = "";
		if (state !== undefined && state !== lastState) {
			lastState = state;
			lastChangeAt = at;
			events += `event: state\ndata: ${state}\n\n`;
		}
		events += `event: poll\ndata: ${JSON.stringify({ at, every: HELM_POLL_MS })}\n\n`;
		events += nextLog();
		for (const stream of streams) stream.write(events);
	}, HELM_POLL_MS);
	poll.unref();

	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
			// The current state as this tab's baseline.
			const state = readState();
			if (state !== undefined) {
				if (!streams.size) lastState = state;
				res.write(`event: state\ndata: ${state}\n\n`);
			}
			streams.add(res);
			res.on("close", () => streams.delete(res));
			return;
		}
		const header = req.headers["x-helm-token"];
		if (!sameToken(Array.isArray(header) ? header[0] : header, token))
			return send(res, 403, "application/json", JSON.stringify({ error: "forbidden" }));
		const id = url.searchParams.get("id") ?? "";
		try {
			if (req.method === "POST" && url.pathname === "/api/kind-check") {
				const body = await readJsonBody(req);
				return sendJson(
					res,
					helmKindCheck(cwd, String(body.repo ?? ""), String(body.kind ?? ""), body.schema),
				);
			}
			if (req.method === "POST" && url.pathname === "/api/run")
				return streamVerb(cwd, await readJsonBody(req), res);
			if (req.method === "POST" && url.pathname === "/api/sync/pull")
				return sendJson(res, helmPull(cwd));
			if (req.method === "POST" && url.pathname === "/api/sync/push")
				return sendJson(res, helmPush(cwd));
			if (req.method === "POST" && url.pathname === "/api/sync/squash") {
				const body = await readJsonBody(req);
				return sendJson(res, helmSquash(cwd, String(body.message ?? "")));
			}
			if (req.method === "GET" && url.pathname === "/api/sync/unpushed")
				return sendJson(res, helmUnpushed(cwd));
			if (req.method === "POST" && url.pathname === "/api/branches/merge") {
				const body = await readJsonBody(req);
				return sendJson(res, helmMerge(cwd, String(body.branch ?? "")));
			}
			if (req.method === "GET" && url.pathname === "/api/branches")
				return sendJson(res, helmBranches(cwd));
			if (req.method === "POST") return sendJson(res, await helmWrite(cwd, url.pathname, req));
			if (url.pathname === "/api/dives")
				return sendJson(
					res,
					helmDives(
						cwd,
						url.searchParams.get("q") || undefined,
						url.searchParams.get("root") || undefined,
						url.searchParams.get("feat") || undefined,
					),
				);
			if (req.method !== "GET") return sendJson(res, undefined);
			if (url.pathname === "/api/repos")
				return sendJson(res, helmRepoList(cwd, url.searchParams.get("root") || undefined));
			if (url.pathname === "/api/internals") return sendJson(res, helmInternals(cwd, lastChangeAt));
			if (url.pathname === "/api/creatable") return sendJson(res, helmCreatableKinds(cwd));
			if (url.pathname === "/api/roots")
				return sendJson(res, helmRoots(cwd, url.searchParams.get("root") || undefined));
			if (url.pathname === "/api/root-repos") return sendJson(res, helmRootRepos(cwd, id));
			if (url.pathname === "/api/doc")
				return sendJson(res, helmDoc(cwd, id, url.searchParams.get("repo") || undefined));
			if (url.pathname === "/api/context")
				return sendJson(
					res,
					helmContext(
						cwd,
						url.searchParams.get("root") ?? "",
						url.searchParams.get("feat") || undefined,
						url.searchParams.get("repo") || undefined,
						url.searchParams.get("dive") || undefined,
					),
				);
			if (url.pathname === "/api/kind-docs")
				return sendJson(
					res,
					helmKindDocs(cwd, url.searchParams.get("repo") ?? "", url.searchParams.get("kind") ?? ""),
				);
			return sendJson(res, undefined);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const status = err instanceof HelmRequestError ? err.status : 500;
			return send(res, status, "application/json", JSON.stringify({ error: message }));
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
				clearInterval(poll);
				server.close(() => resolveClose());
				// An open browser tab holds keep-alive sockets that would stall close.
				server.closeAllConnections();
			}),
	};
}
