import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { namespacedUuid } from "../command-identifiers.mjs";
import {
	assertOk,
	createBridge,
	createTmp,
	gitCommit,
	run,
	runTool,
	write,
} from "../test-helpers.mjs";

const tmp = createTmp("make");
const minted = run(["mint", "2"], tmp);
assertOk(minted, "mint failed");
const [BACKLOG, BRIDGE_REPO] = minted.stdout.trim().split(/\r?\n/);

function fixture(name) {
	const bridge = createBridge(tmp, name, { backlog: BACKLOG, bridge: BRIDGE_REPO });
	write(
		join(bridge, "kb", `${BACKLOG}.md`),
		`---\nkind: memo\nid: ${BACKLOG}\nname: backlog\ngist: "Backlog"\n---\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	return bridge;
}

const lastSubject = (bridge) => runTool("git", ["log", "-1", "--format=%s"], bridge).stdout.trim();
const configText = (bridge) => readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");

test("make deck slugs the name, writes the deck at its deterministic id, and adds it to decks", () => {
	const bridge = fixture("make-deck");
	const made = run(["make", "deck", "Magic:", "The", "Gathering"], bridge);
	assertOk(made, "make deck failed");

	const id = namespacedUuid(BRIDGE_REPO, "magic-the-gathering");
	const path = join(bridge, "kb", `${id}.md`);
	assert.match(made.stdout, new RegExp(`^Made kb[\\\\/]${id}\\.md$`, "m"));
	const text = readFileSync(path, "utf8");
	assert.match(text, /^kind: deck$/m);
	assert.match(text, new RegExp(`^id: ${id}$`, "m"));
	assert.match(text, /^name: magic-the-gathering$/m);
	assert.match(text, /^# Magic: The Gathering$/m);
	// With no decks: yet, the backlog is written in first so it stays visible.
	assert.match(configText(bridge), new RegExp(`^decks: ${BACKLOG}, magic-the-gathering$`, "m"));
	assert.equal(lastSubject(bridge), "deck(magic-the-gathering): created");
	assert.equal(runTool("git", ["status", "--porcelain"], bridge).stdout.trim(), "");

	const again = run(["make", "deck", "magic the gathering"], bridge);
	assert.equal(again.status, 1);
	assert.match(again.stderr, /deck magic-the-gathering already exists/);
	assert.equal(lastSubject(bridge), "deck(magic-the-gathering): created");
});

test("make deck gives a configured tag its missing doc without listing it twice", () => {
	const bridge = fixture("make-configured");
	const config = join(bridge, ".nosedive", "config.yaml");
	write(config, `${configText(bridge)}decks: ${BACKLOG}, ideas\n`);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "configure ideas");

	assertOk(run(["make", "deck", "ideas"], bridge), "make deck failed");
	assert.ok(existsSync(join(bridge, "kb", `${namespacedUuid(BRIDGE_REPO, "ideas")}.md`)));
	assert.match(configText(bridge), new RegExp(`^decks: ${BACKLOG}, ideas$`, "m"));
});

test("make refuses what it cannot make", () => {
	const bridge = fixture("make-refusals");
	const nothing = run(["make", "deck", "!!!"], bridge);
	assert.equal(nothing.status, 1);
	assert.match(nothing.stderr, /deck name has nothing to slug/);

	const unknown = run(["make", "widget", "x"], bridge);
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /make knows how to make: deck/);

	const bare = run(["make", "deck"], bridge);
	assert.equal(bare.status, 1);
	assert.match(bare.stderr, /make deck requires a name/);
});
