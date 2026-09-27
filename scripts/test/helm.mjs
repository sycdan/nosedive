import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	cli,
	createBridge,
	createTmp,
	gitCommit,
	implRepo,
	run,
	runTool,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const tmp = createTmp("helm");
const minted = run(["mint", "5"], tmp);
assertOk(minted, "mint failed");
const [BACKLOG, BRIDGE_REPO, HYDRATED, INSTALLED, UNLISTED] = minted.stdout.trim().split(/\r?\n/);

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
			`  - ${HYDRATED}`,
			`  - ${INSTALLED}`,
			"---",
			"",
		].join("\n"),
	);
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
	return { child, url };
}

test("helm serves a token-guarded board: bridge first, then backlog repos", async (t) => {
	const bridge = fixture();
	const { child, url } = startHelm(bridge);
	t.after(() => child.kill());
	const base = await url;
	const token = base.searchParams.get("token");

	const page = await fetch(base);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /<title>helm/i);

	assert.equal((await fetch(new URL("/", base))).status, 403, "page without token");
	const api = new URL("/api/board", base);
	assert.equal((await fetch(api)).status, 403, "api without token");
	assert.equal(
		(await fetch(api, { headers: { "x-helm-token": "0".repeat(token.length) } })).status,
		403,
		"api with wrong token",
	);

	const board = await (await fetch(api, { headers: { "x-helm-token": token } })).json();
	assert.deepEqual(
		board.repos.map((repo) => repo.id),
		[BRIDGE_REPO, HYDRATED, INSTALLED],
		"bridge first, then backlog repos; unlisted repos are not shown",
	);
	const [bridgeCard, hydratedCard, installedCard] = board.repos;

	assert.equal(bridgeCard.isBridge, true);
	assert.equal(bridgeCard.icon, "🛰");
	assert.deepEqual(bridgeCard.nosedive, { level: 2 });
	assert.match(bridgeCard.hydrated.commit, /^[0-9a-f]{40}$/);

	assert.equal(hydratedCard.name, "hydrated");
	assert.equal(hydratedCard.icon, null);
	assert.match(hydratedCard.hydrated.commit, /^[0-9a-f]{40}$/);
	assert.equal(hydratedCard.hydrated.atTrunk, true);
	assert.equal(hydratedCard.nosedive, null, "no config file means not installed");

	assert.equal(installedCard.hydrated, null);
	assert.deepEqual(installedCard.nosedive, { level: 1 }, "read from trunk without hydrating");
});

test("helm refuses a request whose Host is not the address it bound", async (t) => {
	const bridge = join(tmp, "bridge");
	const { child, url } = startHelm(bridge);
	t.after(() => child.kill());
	const base = await url;
	const { request } = await import("node:http");
	const status = await new Promise((resolveStatus, reject) => {
		const req = request(
			{
				host: base.hostname,
				port: base.port,
				path: `/api/board`,
				headers: { host: "evil.example", "x-helm-token": base.searchParams.get("token") },
			},
			(res) => resolveStatus(res.statusCode),
		);
		req.on("error", reject);
		req.end();
	});
	assert.equal(status, 403);
});
