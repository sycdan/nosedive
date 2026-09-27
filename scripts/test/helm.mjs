import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { namespacedUuid } from "../command-identifiers.mjs";
import {
	assertOk,
	cli,
	createBridge,
	createTmp,
	gitCommit,
	implRepo,
	libUrl,
	run,
	runTool,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const tmp = createTmp("helm");
const minted = run(["mint", "6"], tmp);
assertOk(minted, "mint failed");
const [BACKLOG, BRIDGE_REPO, HYDRATED, INSTALLED, UNLISTED, FEAT] = minted.stdout
	.trim()
	.split(/\r?\n/);
const { parseHelmDecks } = await import(libUrl);

function fixture() {
	const bridge = createBridge(tmp, "bridge", { backlog: BACKLOG, bridge: BRIDGE_REPO });
	const hydrated = implRepo(tmp, "hydrated");
	const installed = implRepo(tmp, "installed");
	const unlisted = implRepo(tmp, "unlisted");

	// An installed repo is one whose trunk carries a nosedive config with a level.
	write(
		join(installed.source, ".nosedive", "config.yaml"),
		"compatibility-level: 1\nkb: ./notes\n",
	);
	runTool("git", ["add", "."], installed.source);
	gitCommit(installed.source, "install nosedive");
	runTool("git", ["push", "cloud", "main"], installed.source);

	writeImplRepoDoc(bridge, HYDRATED, hydrated);
	writeImplRepoDoc(bridge, INSTALLED, installed);
	writeImplRepoDoc(bridge, UNLISTED, unlisted);
	write(
		join(bridge, "kb", `${BRIDGE_REPO}.md`),
		`---\nkind: repo\nid: ${BRIDGE_REPO}\nname: bridge\ngist: "The bridge"\nmeta:\n  path: .\n  trunk: main\n  icon: "🛰"\n---\n`,
	);
	write(
		join(bridge, "kb", `${BACKLOG}.md`),
		[
			"---",
			"kind: memo",
			`id: ${BACKLOG}`,
			"name: backlog",
			'gist: "Backlog"',
			"scopes:",
			`  - ${BRIDGE_REPO}`,
			`  - ${HYDRATED}`,
			`  - ${INSTALLED}`,
			"links:",
			`  - kb/${FEAT}.md:`,
			"      rel: current.feat",
			`  - kb/${UNLISTED}.md:`,
			"      rel: linked.repo",
			"---",
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${FEAT}.md`),
		[
			"---",
			"kind: feat",
			`id: ${FEAT}`,
			"name: the-feat",
			'gist: "A feat"',
			"links:",
			"  - https://example.com/pr/1:",
			"      rel: pr",
			`  - kb/${BACKLOG}.md`,
			"  - kb/artifacts/missing.mjs",
			"---",
			"",
			"# The Feat",
			"",
			"## Why",
			"",
			"See [the docs](https://example.com/docs). <script>alert(1)</script>",
			"",
		].join("\n"),
	);
	const config = join(bridge, ".nosedive", "config.yaml");
	write(config, `${readFileSync(config, "utf8")}decks: ${BACKLOG}, ideas\n`);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	assertOk(run(["hydrate-repo.workspace", HYDRATED], bridge), "hydrate failed");
	// Leaves the managed cache behind, which is what the board reads trunk from.
	assertOk(run(["hydrate-repo.workspace", INSTALLED], bridge), "hydrate failed");
	assertOk(run(["dehydrate-repo.workspace", INSTALLED], bridge), "dehydrate failed");
	return bridge;
}

/** Starts helm and resolves with its URL once it says where it is listening. */
function startHelm(cwd) {
	const child = spawn(process.execPath, [cli, "helm"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	const url = new Promise((resolveUrl, reject) => {
		child.stdout.on("data", (chunk) => {
			out += chunk;
			const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(out);
			if (match) resolveUrl(new URL(match[1]));
		});
		child.stderr.on("data", (chunk) => (err += chunk));
		child.on("exit", (code) => reject(new Error(`helm exited ${code}\n${out}\n${err}`)));
	});
	url.catch(() => {});
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	// Awaiting the exit frees the port before the next launch binds it.
	const stop = () => {
		child.kill();
		return exited;
	};
	return { url, stop };
}

test("helm decks: config forms, missing means the backlog", () => {
	assert.deepEqual(parseHelmDecks("a, b,c", BACKLOG), ["a", "b", "c"]);
	assert.deepEqual(parseHelmDecks(["a", "b"], BACKLOG), ["a", "b"]);
	assert.deepEqual(parseHelmDecks(undefined, BACKLOG), [BACKLOG]);
	assert.deepEqual(parseHelmDecks(undefined, undefined), []);
	assert.throws(() => parseHelmDecks("Not A Slug", BACKLOG), /deck tag/);
});

test("helm serves decks as a link tree over a token-guarded API", async (t) => {
	const bridge = fixture();
	const { url, stop } = startHelm(bridge);
	t.after(stop);
	const base = await url;
	const token = base.searchParams.get("token");
	const get = async (path) => {
		const res = await fetch(new URL(path, base), { headers: { "x-helm-token": token } });
		assert.equal(res.status, 200, `${path}: ${res.status}`);
		return res.json();
	};

	const page = await fetch(base);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /<title>helm/i);

	assert.equal((await fetch(new URL("/", base))).status, 403, "page without token");
	const api = new URL("/api/decks", base);
	assert.equal((await fetch(api)).status, 403, "api without token");
	assert.equal(
		(await fetch(api, { headers: { "x-helm-token": "0".repeat(token.length) } })).status,
		403,
		"api with wrong token",
	);

	// A tag deck is created at a deterministic id and committed on startup.
	const ideas = namespacedUuid(BRIDGE_REPO, "ideas");
	const ideasText = readFileSync(join(bridge, "kb", `${ideas}.md`), "utf8");
	assert.match(ideasText, /^kind: deck$/m);
	assert.match(ideasText, /^name: ideas$/m);
	assert.equal(
		runTool("git", ["log", "-1", "--format=%s"], bridge).stdout.trim(),
		"deck(ideas): created",
	);
	assert.equal(runTool("git", ["status", "--porcelain", "kb"], bridge).stdout.trim(), "");

	const { bridge: bridgeInfo, decks } = await get("/api/decks");
	assert.deepEqual(bridgeInfo, { id: BRIDGE_REPO, name: "bridge" });
	assert.deepEqual(
		decks.map((deck) => [deck.id, deck.name]),
		[
			[BACKLOG, "backlog"],
			[ideas, "ideas"],
		],
	);

	const repos = await get(`/api/deck-repos?id=${BACKLOG}`);
	assert.deepEqual(
		repos.map((repo) => repo.id),
		[BRIDGE_REPO, HYDRATED, INSTALLED],
		"the deck's scoped repos in scope order; a repo it only links is not shown",
	);
	const [bridgeCard, hydratedCard, installedCard] = repos;
	assert.equal(bridgeCard.isBridge, true);
	assert.equal(bridgeCard.icon, "🛰");
	assert.deepEqual(bridgeCard.nosedive, { level: 2 });
	assert.match(bridgeCard.hydrated.commit, /^[0-9a-f]{40}$/);
	assert.equal(hydratedCard.name, "hydrated");
	assert.equal(hydratedCard.icon, null);
	assert.equal(hydratedCard.hydrated.atTrunk, true);
	assert.equal(hydratedCard.nosedive, null, "no config file means not installed");
	assert.equal(installedCard.hydrated, null);
	assert.deepEqual(installedCard.nosedive, { level: 1 }, "read from trunk without hydrating");
	assert.deepEqual(await get(`/api/deck-repos?id=${ideas}`), []);

	const backlog = await get(`/api/doc?id=${BACKLOG}`);
	assert.deepEqual(
		backlog.links.map((link) => [link.type, link.id ?? link.target, link.rel ?? null]),
		[
			["doc", FEAT, "current.feat"],
			["doc", UNLISTED, "linked.repo"],
		],
	);
	assert.equal(backlog.links[0].name, "the-feat");
	assert.equal(backlog.links[0].kind, "feat");

	const feat = await get(`/api/doc?id=${FEAT}`);
	assert.equal(feat.kind, "feat");
	assert.deepEqual(
		feat.links.map((link) => [link.type, link.id ?? link.target]),
		[
			["url", "https://example.com/pr/1"],
			["doc", BACKLOG],
			["file", "kb/artifacts/missing.mjs"],
		],
	);
	assert.match(feat.html, /<h2[^>]*>Why<\/h2>/);
	assert.match(feat.html, /<a href="https:\/\/example.com\/docs"/);
	assert.doesNotMatch(feat.html, /<script>/, "raw html in a doc body is escaped");
	assert.match(feat.frontmatter, /^kind: feat$/m);

	const missing = await fetch(new URL(`/api/doc?id=${UNLISTED}0`, base), {
		headers: { "x-helm-token": token },
	});
	assert.equal(missing.status, 404);
});

test("helm refuses a request whose Host is not the address it bound", async (t) => {
	const bridge = join(tmp, "bridge");
	const commits = runTool("git", ["rev-list", "--count", "HEAD"], bridge).stdout;
	const { url, stop } = startHelm(bridge);
	t.after(stop);
	const base = await url;
	const { request } = await import("node:http");
	const status = await new Promise((resolveStatus, reject) => {
		const req = request(
			{
				host: base.hostname,
				port: base.port,
				path: `/api/decks`,
				headers: { host: "evil.example", "x-helm-token": base.searchParams.get("token") },
			},
			(res) => resolveStatus(res.statusCode),
		);
		req.on("error", reject);
		req.end();
	});
	assert.equal(status, 403);
	assert.equal(
		runTool("git", ["rev-list", "--count", "HEAD"], bridge).stdout,
		commits,
		"an existing tag deck is not recreated",
	);
});

/** Reads server-sent events off a helm stream, one `{ event, data }` at a time. */
function events(res) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return {
		async next() {
			while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
			const end = buffer.indexOf("\n\n");
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			return {
				event: /^event: (.*)$/m.exec(block)?.[1],
				data: /^data: (.*)$/m.exec(block)?.[1],
			};
		},
		cancel: () => reader.cancel(),
	};
}

test("a restarted helm keeps its URL and tells open pages it rebooted", async (t) => {
	const bridge = join(tmp, "bridge");
	const first = startHelm(bridge);
	t.after(first.stop);
	const base = await first.url;
	const token = base.searchParams.get("token");
	const port = Number(base.port);
	assert.ok(port >= 20000 && port < 30000, `port ${port} is derived into 20000-29999`);

	assert.equal(
		(await fetch(new URL("/api/events?token=0", base))).status,
		403,
		"the event stream is token-guarded",
	);
	const bootOf = async (url) => {
		const res = await fetch(new URL(`/api/events?token=${token}`, url));
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type"), /text\/event-stream/);
		const stream = events(res);
		const boot = await stream.next();
		await stream.cancel();
		assert.equal(boot.event, "boot");
		return boot.data;
	};
	const firstBoot = await bootOf(base);
	await first.stop();

	// An open tab survives a restart only if the server comes back where it was
	// and still accepts the token the tab holds.
	const second = startHelm(bridge);
	t.after(second.stop);
	const again = await second.url;
	assert.equal(again.href, base.href);
	assert.notEqual(await bootOf(again), firstBoot);
});
