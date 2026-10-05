import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

const tmp = createTmp("helm-scopes");
const minted = run(["mint", "6"], tmp);
assertOk(minted, "mint failed");
const [BACKLOG, CARDS, DECKS, FEAT, PARENT, CHILD] = minted.stdout.trim().split(/\r?\n/);

/** A backlog scoping one repo and reaching a feat that scopes none; a scoped feat whose child scopes none. */
function fixture() {
	const bridge = createBridge(tmp, "bridge", { backlog: BACKLOG });
	writeImplRepoDoc(bridge, CARDS, implRepo(tmp, "cards"));
	writeImplRepoDoc(bridge, DECKS, implRepo(tmp, "decks"));
	write(
		join(bridge, "kb", `${BACKLOG}.md`),
		`---\nkind: memo\nid: ${BACKLOG}\nname: backlog\ngist: "Backlog"\nscopes:\n  - ${CARDS}\nlinks:\n  - kb/${FEAT}.md:\n      rel: current.feat\n---\n`,
	);
	write(
		join(bridge, "kb", `${FEAT}.md`),
		`---\nkind: feat\nid: ${FEAT}\nname: elves\ngist: "Elf deck"\nlinks:\n  - kb/${BACKLOG}.md:\n      rel: parent\n---\n\n# Elves\n`,
	);
	write(
		join(bridge, "kb", `${PARENT}.md`),
		`---\nkind: feat\nid: ${PARENT}\nname: goblins\ngist: "Goblin deck"\nscopes:\n  - ${DECKS}:\n      work-branch: work/goblins\n---\n`,
	);
	write(
		join(bridge, "kb", `${CHILD}.md`),
		`---\nkind: feat\nid: ${CHILD}\nname: hobs\ngist: "Hobgoblins"\nlinks:\n  - kb/${PARENT}.md:\n      rel: parent\n---\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
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

test("helm's repo cards add, drop and repin scopes on a dive, a feat and the backlog", async (t) => {
	const bridge = fixture();
	const { url, stop } = startHelm(bridge);
	t.after(stop);
	const base = await url;
	const token = base.searchParams.get("token");
	const headers = { "x-helm-token": token, "content-type": "application/json" };
	const verb = async (body) => {
		const res = await fetch(new URL("/api/run", base), {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		assert.equal(res.status, 200);
		return res.text();
	};
	const ok = (text) => assert.match(text, /\[exit 0\]\s*$/, text);
	const cards = async (query) => {
		const res = await fetch(new URL(`/api/context?${query}`, base), { headers });
		const context = await res.json();
		return Object.fromEntries(context.repos.map((repo) => [repo.id, repo.scope]));
	};
	const doc = (id) => readFileSync(join(bridge, "kb", `${id}.md`), "utf8");

	// No dive: a feat's own scopes, not what it inherits from the backlog.
	assert.deepEqual(await cards(`root=${BACKLOG}&feat=${FEAT}`), { [CARDS]: null, [DECKS]: null });
	ok(await verb({ verb: "feat-scope", doc: FEAT, repo: DECKS, branch: "work/elves" }));
	assert.match(
		doc(FEAT),
		new RegExp(`^scopes:\\n {2}- ${DECKS}:\\n {6}work-branch: work/elves$`, "m"),
	);
	assert.doesNotMatch(doc(FEAT), new RegExp(CARDS), "the backlog's scopes are not copied");
	assert.deepEqual((await cards(`root=${BACKLOG}&feat=${FEAT}`))[DECKS], {
		workBranch: "work/elves",
	});
	ok(await verb({ verb: "feat-scope", doc: FEAT, repo: DECKS, branch: "" }));
	assert.match(doc(FEAT), new RegExp(`^scopes:\\n {2}- ${DECKS}$`, "m"), "no branch: a bare scope");
	ok(await verb({ verb: "feat-scope", doc: FEAT, repo: DECKS, drop: true }));
	assert.doesNotMatch(doc(FEAT), /^scopes:/m);

	// A feat's first own scope copies its nearest scoped ancestor's, branches included, in one commit.
	const commits = () => Number(runTool("git", ["rev-list", "--count", "HEAD"], bridge).stdout);
	const before = commits();
	ok(await verb({ verb: "feat-scope", doc: CHILD, repo: CARDS, branch: "work/hobs" }));
	assert.match(
		doc(CHILD),
		new RegExp(
			`^scopes:\\n {2}- ${DECKS}:\\n {6}work-branch: work/goblins\\n {2}- ${CARDS}:\\n {6}work-branch: work/hobs$`,
			"m",
		),
	);
	assert.equal(commits(), before + 1);

	// The backlog, at level 0, is edited the same way.
	assert.deepEqual((await cards(`root=${BACKLOG}`))[CARDS], { workBranch: null });
	ok(await verb({ verb: "feat-scope", doc: BACKLOG, repo: CARDS, drop: true }));
	assert.doesNotMatch(doc(BACKLOG), /^scopes:/m);
	assert.match(
		runTool("git", ["log", "-1", "--format=%s"], bridge).stdout,
		new RegExp(`^crud\\(${BACKLOG}\\): updated memo backlog`),
		"crud commits each edit",
	);

	// A dive: add, repin, drop, through record.dive and crud --repin.
	const recorded = run(["record.dive", "--feat", FEAT], bridge);
	assertOk(recorded, "record.dive failed");
	const dive = /^id: (\S+)$/m.exec(
		readFileSync(join(bridge, /^Recorded (.+)$/m.exec(recorded.stdout)[1]), "utf8"),
	)[1];
	ok(await verb({ verb: "upscope", dive, repo: CARDS, branch: "work/cards" }));
	assert.deepEqual((await cards(`root=${BACKLOG}&dive=${dive}`))[CARDS], {
		workBranch: "work/cards",
	});
	ok(await verb({ verb: "repin", dive, repo: CARDS, ref: "main" }));
	assert.match(
		doc(dive),
		new RegExp(`^ {2}- ${CARDS}:\\n {6}ref: [0-9a-f]{40}\\n {6}work-branch: work/cards$`, "m"),
	);
	const refused = await verb({ verb: "repin", dive, repo: CARDS, ref: "work/cards" });
	assert.match(
		refused,
		/origin has no ref work\/cards in repo cards/,
		"nosedive's refusal, verbatim",
	);
	assert.match(refused, /\[exit 1\]\s*$/);
	ok(await verb({ verb: "unscope", dive, repo: CARDS }));
	assert.equal((await cards(`root=${BACKLOG}&dive=${dive}`))[CARDS], null);

	// Read-only: upscoped, then its branch cleared by crud on the bridge's copy; the pin stays.
	ok(await verb({ verb: "upscope", dive, repo: CARDS, readOnly: true, branch: "ignored" }));
	assert.match(doc(dive), new RegExp(`^ {2}- ${CARDS}:\\n {6}ref: [0-9a-f]{40}\\n(?! {6})`, "m"));
	assert.deepEqual((await cards(`root=${BACKLOG}&dive=${dive}`))[CARDS], { workBranch: null });
	assert.match(
		runTool("git", ["log", "-1", "--format=%s"], bridge).stdout,
		new RegExp(`^crud\\(${dive}\\): updated dive`),
	);
});
