import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";

import { cli, cliEnv, createTmp, root, seededBridge } from "../test-helpers.mjs";

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

test("with no dive, helm offers every kind, planned on a dive of the deck; a repo mints there", async (t) => {
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
		["dive", "kind", "memo", "repo"],
		"with no dive, Add offers every creatable kind",
	);

	// crud writes only on a dive, so with none Add jumps the deck's feat, then
	// plans the dive on that one, to land with it.
	const unplanned = await post("/api/crud/dive", {
		feat: KB_FEAT,
		gist: "Adds the repo cards",
		brief: "Made in helm with no dive.",
	});
	assert.equal(unplanned.status, 400, "crud refuses a dive planned on no dive");
	const context = await get(`/api/context?root=${KB_FEAT}`);
	assert.ok(context.repos.find((repo) => repo.id === bridgeId)?.inScope);
	assert.equal(context.repos.find((repo) => repo.id === bridgeId)?.inCrudContext, false);
	for (const [path, body] of [
		["/api/crud/mint", { repo: bridgeId, kind: "memo", gist: "No dive" }],
		["/api/crud/meta", { repo: bridgeId, id: bridgeId, patch: { merge: "fast-forward" } }],
		["/api/crud/title", { repo: bridgeId, id: bridgeId, title: "No dive" }],
	]) {
		const refused = await post(path, body);
		assert.equal(refused.status, 409, `${path} refuses before the client jumps`);
	}
	const jumped = await post("/api/run", { verb: "jump", ref: KB_FEAT });
	assert.match(jumped.text, /\[exit 0\]\s*$/, jumped.text);
	const dive = /jump: recorded \S*?([0-9a-f-]{36})\.md/.exec(jumped.text)?.[1];
	assert.ok(dive, jumped.text);
	const recorded = await post("/api/crud/dive", {
		feat: KB_FEAT,
		name: "Add repo cards",
		gist: "Adds the repo cards",
	});
	assert.equal(recorded.status, 200, recorded.text);
	assert.match(recorded.body.stdout, /Recorded workspace[\\/]__self[\\/]kb[\\/]/);
	const plannedId = /([0-9a-f-]{36})\.md/.exec(recorded.body.stdout)[1];
	const plannedDoc = readFileSync(
		join(bridge, "workspace", "__self", "kb", `${plannedId}.md`),
		"utf8",
	);
	assert.match(plannedDoc, /^name: add-repo-cards$/m);
	assert.doesNotMatch(plannedDoc, /^## Brief$/m);
	assert.ok(
		!existsSync(join(bridge, "kb", `${plannedId}.md`)),
		"planned dive is not on the live bridge",
	);

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

// Exercise the shipped client helper: a refused jump never calls a write, and
// a successful streamed jump refreshes dive state before the original payload.
test("content writes stream a deck jump before writing and stop on refusal", async () => {
	const source = readFileSync(join(root, "src/lib/helmEdit.ts"), "utf8");
	const helper = source.slice(
		source.indexOf("let diveWrites = 0;"),
		source.indexOf("async function write(path, body)"),
	);
	for (const exit of [1, 0]) {
		const calls = [];
		const classes = new Set();
		const out = {
			hidden: true,
			textContent: "",
			classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v) },
		};
		const payload = { repo: "repo", kind: "memo", gist: "Kept input" };
		const context = {
			TextDecoder,
			out,
			payload,
			dives: { active: null },
			ctx: { root: "deck-ref" },
			token: "token",
			fetch: async (path, init) => {
				calls.push([path, JSON.parse(init.body)]);
				const chunks = ["jumping deck\n", `[exit ${exit}]\n`];
				let index = 0;
				return {
					ok: true,
					body: {
						getReader: () => ({
							read: async () =>
								index < chunks.length
									? { value: new TextEncoder().encode(chunks[index++]), done: false }
									: { done: true },
						}),
					},
				};
			},
			loadDives: async () => {
				calls.push("dives");
				context.dives.active = { id: "new-dive" };
			},
			loadRoots: async () => calls.push("roots"),
			refreshSections: () => calls.push("sections"),
			write: async (path, body) => {
				assert.ok(context.dives.active);
				assert.equal(body, payload);
				calls.push([path, body]);
				return { stdout: "minted" };
			},
		};
		const result = new Script(
			helper + '\nwriteOnDive("/api/crud/mint", payload, out)',
		).runInNewContext(context);
		if (exit) {
			await assert.rejects(result, /jumping deck\n\[exit 1\]/);
			assert.equal(calls.length, 1);
		} else {
			assert.equal((await result).stdout, "minted");
			assert.deepEqual(calls.slice(1, 4), ["dives", "roots", "sections"]);
			assert.equal(calls[4][0], "/api/crud/mint");
		}
		assert.deepEqual(calls[0], ["/api/run", { verb: "jump", ref: "deck-ref" }]);
		assert.equal(out.hidden, false);
		assert.equal(classes.has("streaming"), false);
	}
});
