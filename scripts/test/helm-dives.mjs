import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	cli,
	createTmp,
	gitCommit,
	run,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("helm-dives");
const minted = run(["mint", "3"], tmp);
assertOk(minted, "mint failed");
const [BACKLOG, REPO, FEAT] = minted.stdout.trim().split(/\r?\n/);

/** A pushable bridge whose backlog reaches a feat scoped to one repo, as pack's tests build it. */
function fixture() {
	const origin = join(tmp, "origin.git");
	mkdirSync(origin, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], origin);
	const source = join(tmp, "source");
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, "base");

	const bridge = join(tmp, "bridge");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Helm Test"], bridge);
	runTool("git", ["config", "user.email", "helm@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: BACKLOG });
	write(
		join(bridge, "kb", `${REPO}.md`),
		`---\nkind: repo\nid: ${REPO}\nname: cards\ngist: "Cards"\nmeta:\n  path: workspace/cards\n  trunk: main\n  remotes:\n    local: ${source.replaceAll("\\", "/")}\n---\n`,
	);
	write(
		join(bridge, "kb", `${FEAT}.md`),
		`---\nkind: feat\nid: ${FEAT}\nname: elves\ngist: "Elf deck"\nscopes:\n  - ${REPO}:\n      work-branch: work/elves\n---\n\n# Elves\n`,
	);
	write(
		join(bridge, "kb", `${BACKLOG}.md`),
		`---\nkind: memo\nid: ${BACKLOG}\nname: backlog\ngist: "Backlog"\nscopes:\n  - ${REPO}\nlinks:\n  - kb/${FEAT}.md:\n      rel: current.feat\n---\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "bridge");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);
	return bridge;
}

function startHelm(cwd) {
	const child = spawn(process.execPath, [cli, "helm"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

test("helm lists dives and runs the dive lifecycle through the real commands", async (t) => {
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
	/** Runs a verb and reads its streamed output to the end, chunk by chunk. */
	const runVerb = async (body) => {
		const res = await fetch(new URL("/api/run", base), {
			method: "POST",
			headers: { "x-helm-token": token, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (res.status !== 200) return { status: res.status, text: await res.text() };
		assert.match(res.headers.get("content-type"), /^text\/plain/);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let text = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value);
		}
		const exit = /\[exit (\d+)\]\s*$/.exec(text)?.[1];
		return { status: res.status, text, exit: exit === undefined ? undefined : Number(exit) };
	};
	const marker = join(bridge, "workspace", ".nosedive-ref");

	assert.deepEqual((await get("/api/dives")).dives, [], "nothing planned yet");

	// Planning a dive is a crud write, so helm refuses it with no dive; it is recorded outside.
	const planned = await runVerb({ verb: "dive", feat: FEAT, gist: "x", brief: "x" });
	assert.equal(planned.status, 400, "helm no longer runs a dive verb");
	assertOk(
		run(
			[
				"record.dive",
				"--feat",
				FEAT,
				"--gist",
				"Sort the elves",
				"--title",
				"Sort elves",
				"--brief",
				"-",
			],
			bridge,
			"Put the elves in order.\n",
		),
		"record.dive failed",
	);
	const listing = await get("/api/dives");
	assert.equal(listing.active, null);
	assert.equal(listing.dives.length, 1);
	const [dive] = listing.dives;
	assert.equal(dive.gist, "Sort the elves");
	assert.equal(dive.title, "Sort elves");
	assert.equal(dive.feat, "elves");
	assert.deepEqual(dive.repos, ["cards"]);
	assert.equal((await get("/api/dives?q=elves")).dives.length, 1, "search by term");
	assert.equal((await get("/api/dives?q=goblins")).dives.length, 0);
	assert.equal((await get(`/api/dives?deck=${BACKLOG}&feat=${FEAT}`)).dives.length, 1, "by feat");
	assert.equal(
		(await get(`/api/dives?deck=${BACKLOG}&feat=${REPO}`)).dives.length,
		0,
		"a doc reaching no dive lists none",
	);

	const staged = await get(`/api/context?deck=${BACKLOG}&dive=${dive.id}`);
	assert.deepEqual(
		staged.repos.map((repo) => repo.id),
		[REPO],
		"a staged dive narrows the repos to its scopes",
	);

	const jumped = await runVerb({ verb: "jump", ref: dive.id });
	assert.equal(jumped.exit, 0, jumped.text);
	assert.match(readFileSync(marker, "utf8"), new RegExp(dive.id));
	assert.equal((await get("/api/dives")).active.id, dive.id);

	const packed = await runVerb({ verb: "pack" });
	assert.equal(packed.exit, 0, packed.text);
	assert.equal(existsSync(marker), false, "pack puts the dive down");
	const log = readFileSync(join(bridge, "workspace", ".scratch", dive.id, "helm.log"), "utf8");
	assert.match(
		log,
		/^## \S+ nosedive jump /m,
		"what helm ran on the dive is logged in its scratch",
	);
	assert.match(
		log,
		/^## \S+ nosedive pack\n\n[\s\S]*\[exit 0\]/m,
		"pack, which ends the dive, too",
	);
	assert.equal((await get("/api/dives")).active, null);

	const refused = await runVerb({ verb: "land" });
	assert.equal(refused.exit, 1, "land with no dive fails, and says why");
	assert.match(refused.text, /active dive, and there isn't one/, "the command's own words");

	// Hydrate and dehydrate from a card run the workspace commands themselves.
	const worktree = join(bridge, "workspace", "cards");
	assert.ok(existsSync(worktree), "packing leaves the scoped repo hydrated");
	write(join(worktree, "scratch.txt"), "unsaved\n");
	const dirty = await runVerb({ verb: "dehydrate", repo: REPO });
	assert.equal(dirty.exit, 1, "a dirty worktree is not thrown away");
	assert.match(dirty.text, /uncommitted/i, "dehydrate's own refusal");
	assert.ok(existsSync(worktree));
	rmSync(join(worktree, "scratch.txt"));
	const dehydrated = await runVerb({ verb: "dehydrate", repo: REPO });
	assert.equal(dehydrated.exit, 0, dehydrated.text);
	assert.equal(existsSync(worktree), false);
	const cardAfter = (await get(`/api/context?deck=${BACKLOG}`)).repos[0];
	assert.equal(cardAfter.hydrated, null);

	const hydrated = await runVerb({ verb: "hydrate", repo: REPO, at: "main" });
	assert.equal(hydrated.exit, 0, hydrated.text);
	assert.ok(existsSync(worktree));
	const card = (await get(`/api/context?deck=${BACKLOG}`)).repos[0];
	assert.match(card.hydrated.commit, /^[0-9a-f]{40}$/);

	const nope = await runVerb({ verb: "nuke" });
	assert.equal(nope.status, 400, "only the dive verbs run");
});
