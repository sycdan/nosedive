import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { cli, cliEnv, createTmp, seededBridge } from "../test-helpers.mjs";

const tmp = createTmp("helm-make");
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";

function startHelm(cwd) {
	const child = spawn(process.execPath, [cli, "helm"], {
		cwd,
		env: cliEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	const url = new Promise((resolveUrl, reject) => {
		child.stdout.on("data", (chunk) => {
			out += chunk;
			const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(out);
			if (match) resolveUrl(new URL(match[1]));
		});
		child.on("exit", (code) => reject(new Error(`helm exited ${code}\n${out}`)));
	});
	url.catch(() => {});
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	return {
		url,
		stop: () => {
			child.kill();
			return exited;
		},
	};
}

test("with no dive, helm offers a dive alone, planned on a dive of the deck; a repo mints there", async (t) => {
	const { bridge } = seededBridge(tmp, "make", "pilot@nosedive.invalid");
	const bridgeId = /^bridge: (\S+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const { url, stop } = startHelm(bridge);
	t.after(stop);
	const base = await url;
	const headers = { "x-helm-token": base.searchParams.get("token") };
	const get = async (path) => (await fetch(new URL(path, base), { headers })).json();
	const post = async (path, body) => {
		const res = await fetch(new URL(path, base), {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, text, body: path === "/api/run" ? {} : JSON.parse(text) };
	};

	assert.deepEqual(
		(await get("/api/creatable")).map((kind) => kind.name),
		["dive"],
		"with no dive, a dive is all Add makes",
	);

	// crud writes only on a dive, so with none Add jumps the deck's feat, then
	// plans the dive on that one, to land with it.
	const unplanned = await post("/api/crud/dive", {
		feat: KB_FEAT,
		gist: "Adds the repo cards",
		brief: "Made in helm with no dive.",
	});
	assert.equal(unplanned.status, 400, "crud refuses a dive planned on no dive");
	const jumped = await post("/api/run", { verb: "jump", ref: KB_FEAT });
	assert.match(jumped.text, /\[exit 0\]\s*$/, jumped.text);
	const dive = /jump: recorded \S*?([0-9a-f-]{36})\.md/.exec(jumped.text)?.[1];
	assert.ok(dive, jumped.text);
	const recorded = await post("/api/crud/dive", {
		feat: KB_FEAT,
		title: "Add repo cards",
		gist: "Adds the repo cards",
		brief: "Made in helm on a dive.",
	});
	assert.equal(recorded.status, 200, recorded.text);
	assert.match(recorded.body.stdout, /Recorded workspace[\\/]__self[\\/]kb[\\/]/);

	const offered = await get("/api/creatable");
	assert.deepEqual(
		offered.map((kind) => kind.name),
		["dive", "kind", "memo", "repo"],
	);
	const repoSchema = offered.find((kind) => kind.name === "repo").schema;
	assert.deepEqual(repoSchema.required, ["remotes"]);
	assert.equal(repoSchema.anyOf, undefined);
	assert.deepEqual(Object.keys(repoSchema.properties.remotes.properties), ["cloud", "local"]);

	const bare = await post("/api/crud/mint", {
		repo: bridgeId,
		kind: "repo",
		gist: "No remotes",
		meta: { url: "https://example.invalid/cards" },
	});
	assert.equal(bare.status, 400, "a new repo doc gives its remotes");
	assert.match(bare.body.error, /required property 'remotes'/);
	const minted = await post("/api/crud/mint", {
		repo: bridgeId,
		kind: "repo",
		gist: "Cards",
		meta: { url: "https://example.invalid/cards", remotes: { local: "X:/srv/repos/cards" } },
	});
	assert.equal(minted.status, 200, minted.text);
	const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(minted.body.stdout)?.[1];
	const doc = join(bridge, "workspace", "__self", "kb", `${id}.md`);
	assert.ok(existsSync(doc), "minted in the dive's __self checkout");
	assert.ok(!existsSync(join(bridge, "kb", `${id}.md`)), "not in the live bridge");
	const liveDive = readFileSync(join(bridge, "kb", `${dive}.md`), "utf8");
	assert.match(liveDive, new RegExp(`^  - kb/${id}\\.md:\\n      rel: made$`, "m"));
	const shownDive = await get(`/api/doc?id=${dive}`);
	assert.ok(
		shownDive.links.some((link) => link.id === id && link.rel === "made" && link.repoName),
		"helm reads made links from the live dive",
	);

	const edited = await post("/api/crud/meta", {
		id,
		repo: bridgeId,
		patch: { trunk: "main", merge: "fast-forward" },
	});
	assert.equal(edited.status, 200, edited.text);
	assert.match(readFileSync(doc, "utf8"), /^ {2}merge: fast-forward$/m);

	// Seed's own repo doc has remotes but no url, and still validates.
	const own = await post("/api/crud/meta", {
		id: bridgeId,
		repo: bridgeId,
		patch: { merge: "fast-forward" },
	});
	assert.equal(own.status, 200, own.text);
});
