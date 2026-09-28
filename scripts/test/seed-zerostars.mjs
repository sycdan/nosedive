import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	root,
	run,
	runTool,
	seededBridge,
	write,
} from "../test-helpers.mjs";

const tmp = createTmp("seed-zerostars");
const KIND = "00000000-0000-70a0-90bd-1d49dc6264b9";
const DECK = "00000000-0000-7d1f-805a-7d0a3bdff309";
const MEMO = "00000000-0000-7bb2-8122-2cad84184e09";
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();
const commits = (cwd) => git(["rev-list", "--count", "HEAD"], cwd);
const config = (bridge) => readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
const configKey = (bridge, key) => new RegExp(`^${key}: (\\S+)$`, "m").exec(config(bridge))?.[1];
const zerostars = (dir) =>
	readdirSync(dir)
		.filter((file) => file.startsWith("00000000-0000-"))
		.sort();

function commitAll(bridge, message) {
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, message);
}

test("seed ships the unscoped zerostars, scopes the kb feat to the bridge, and links it from the backlog", () => {
	const { bridge } = seededBridge(tmp, "fresh", "pilot@nosedive.invalid");
	const kb = join(bridge, "kb");
	assert.deepEqual(zerostars(kb), [KB_FEAT, KIND, MEMO, DECK].map((id) => `${id}.md`).sort());
	for (const id of [KIND, MEMO, DECK])
		assert.equal(
			readFileSync(join(kb, `${id}.md`), "utf8"),
			readFileSync(join(root, "kb", `${id}.md`), "utf8"),
		);

	const feat = readFileSync(join(kb, `${KB_FEAT}.md`), "utf8");
	const self = configKey(bridge, "bridge");
	assert.match(feat, new RegExp(`^scopes:\\n {2}- ${self}:\\n {6}work-branch: work/kb$`, "m"));
	const backlog = readFileSync(join(kb, `${configKey(bridge, "backlog")}.md`), "utf8");
	assert.match(backlog, new RegExp(`- kb/${KB_FEAT}\\.md:\\n {6}rel: zerostar\\.feat`));
	assert.equal(git(["status", "--porcelain"], bridge), "", "seed committed everything it wrote");

	const before = commits(bridge);
	assertOk(run(["seed", "--headless", "--no-push"], bridge, ""), "a second seed failed");
	assert.equal(commits(bridge), before, "a second seed changes nothing");

	const dive = run(
		["record.dive", "--feat", KB_FEAT, "--gist", "Tidy", "--brief", "-"],
		bridge,
		"Tidy the kb",
	);
	assertOk(dive, "the kb feat is something to dive from");
});

test("seed merges the package's change into a shipped doc the pilot edited, and leaves the kb feat alone", () => {
	const { bridge } = seededBridge(tmp, "merge", "pilot@nosedive.invalid");
	const deck = join(bridge, "kb", `${DECK}.md`);
	const shipped = readFileSync(deck, "utf8");
	// Pretend seed last wrote an older deck doc, so the package's copy reads as a change to it.
	write(deck, shipped.replace("A deck carries no meta yet.", "An older last line."));
	commitAll(bridge, "seed(nosedive@old): surface did not change");
	write(deck, readFileSync(deck, "utf8").replace("# Deck", "# Deck, as we use it"));
	commitAll(bridge, "our heading");
	const feat = join(bridge, "kb", `${KB_FEAT}.md`);
	write(feat, `${readFileSync(feat, "utf8")}\nOur notes.\n`);
	commitAll(bridge, "our kb notes");

	const seeded = run(["seed", "--headless", "--no-push"], bridge, "");
	assertOk(seeded, "seed failed");
	assert.match(seeded.stdout, new RegExp(`Merged kb[\\\\/]${DECK}\\.md`));
	const merged = readFileSync(deck, "utf8");
	assert.match(merged, /^# Deck, as we use it$/m, "the pilot's edit survives");
	assert.match(merged, /^A deck carries no meta yet\.$/m, "the package's change arrives");
	assert.match(readFileSync(feat, "utf8"), /Our notes\./, "a create-only doc is never merged");
	assert.equal(git(["status", "--porcelain"], bridge), "");
});

test("seed stops on a conflict with markers left in the doc, and refuses a shipped doc with uncommitted changes", () => {
	const { bridge } = seededBridge(tmp, "conflict", "pilot@nosedive.invalid");
	const deck = join(bridge, "kb", `${DECK}.md`);
	const shipped = readFileSync(deck, "utf8");
	write(deck, shipped.replace("A deck carries no meta yet.", "An older last line."));
	commitAll(bridge, "seed(nosedive@old): surface did not change");
	write(deck, shipped.replace("A deck carries no meta yet.", "Our own last line."));
	commitAll(bridge, "our last line");
	const before = commits(bridge);

	const conflicted = run(["seed", "--headless", "--no-push"], bridge, "");
	assert.equal(conflicted.status, 1, conflicted.stdout);
	assert.match(conflicted.stderr, /conflict with edits in this bridge/);
	assert.match(conflicted.stderr, new RegExp(`kb[\\\\/]${DECK}\\.md`));
	const text = readFileSync(deck, "utf8");
	assert.match(text, /^<<<<<<< bridge$/m);
	assert.match(text, /^>>>>>>> nosedive$/m);
	assert.equal(commits(bridge), before, "nothing is committed");

	const dirty = run(["seed", "--headless", "--no-push"], bridge, "");
	assert.equal(dirty.status, 1);
	assert.match(dirty.stderr, /uncommitted changes/);
	assert.equal(readFileSync(deck, "utf8"), text, "a refused seed touches nothing");
});

test("the memo kind's schema is open: any meta validates", () => {
	const { bridge } = seededBridge(tmp, "memo", "pilot@nosedive.invalid");
	const made = run(["crud", "memo", "Anything", "goes"], bridge);
	assertOk(made, "crud memo failed");
	const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(made.stdout)?.[1];
	const patched = run(["crud", id, "--meta", "-"], bridge, "whatever: 1\nnested: {a: b}\n");
	assertOk(patched, "an open schema takes any key");
	assert.doesNotMatch(patched.stderr, /no schema/);
});
