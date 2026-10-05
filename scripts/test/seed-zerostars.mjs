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
const MEMO = "00000000-0000-7bb2-8122-2cad84184e09";
const DIVE = "00000000-0000-77cb-bcfe-6c9fb07f42ab";
const REPO = "00000000-0000-7dfa-bfc7-99ba38b8ed1e";
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";
const MEMO_LAST_LINE = "`crud memo <gist>` mints one.";

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
	assert.deepEqual(zerostars(kb), [KB_FEAT, KIND, MEMO, DIVE, REPO].map((id) => `${id}.md`).sort());
	for (const id of [KIND, MEMO, DIVE, REPO])
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
	const memo = join(bridge, "kb", `${MEMO}.md`);
	const shipped = readFileSync(memo, "utf8");
	// Pretend seed last wrote an older memo kind doc, so the package's copy reads as a change to it.
	write(memo, shipped.replace(MEMO_LAST_LINE, "An older last line."));
	commitAll(bridge, "seed(nosedive@old): surface did not change");
	write(memo, readFileSync(memo, "utf8").replace("# Memo", "# Memo, as we use it"));
	commitAll(bridge, "our heading");
	const feat = join(bridge, "kb", `${KB_FEAT}.md`);
	write(feat, `${readFileSync(feat, "utf8")}\nOur notes.\n`);
	commitAll(bridge, "our kb notes");

	const seeded = run(["seed", "--headless", "--no-push"], bridge, "");
	assertOk(seeded, "seed failed");
	assert.match(seeded.stdout, new RegExp(`Merged kb[\\\\/]${MEMO}\\.md`));
	const merged = readFileSync(memo, "utf8");
	assert.match(merged, /^# Memo, as we use it$/m, "the pilot's edit survives");
	assert.ok(merged.includes(`\n${MEMO_LAST_LINE}\n`), "the package's change arrives");
	assert.match(readFileSync(feat, "utf8"), /Our notes\./, "a create-only doc is never merged");
	assert.equal(git(["status", "--porcelain"], bridge), "");
});

test("seed stops on a conflict with markers left in the doc, and refuses a shipped doc with uncommitted changes", () => {
	const { bridge } = seededBridge(tmp, "conflict", "pilot@nosedive.invalid");
	const memo = join(bridge, "kb", `${MEMO}.md`);
	const shipped = readFileSync(memo, "utf8");
	write(memo, shipped.replace(MEMO_LAST_LINE, "An older last line."));
	commitAll(bridge, "seed(nosedive@old): surface did not change");
	write(memo, shipped.replace(MEMO_LAST_LINE, "Our own last line."));
	commitAll(bridge, "our last line");
	const before = commits(bridge);

	const conflicted = run(["seed", "--headless", "--no-push"], bridge, "");
	assert.equal(conflicted.status, 1, conflicted.stdout);
	assert.match(conflicted.stderr, /conflict with edits in this bridge/);
	assert.match(conflicted.stderr, new RegExp(`kb[\\\\/]${MEMO}\\.md`));
	const text = readFileSync(memo, "utf8");
	assert.match(text, /^<<<<<<< bridge$/m);
	assert.match(text, /^>>>>>>> nosedive$/m);
	assert.equal(commits(bridge), before, "nothing is committed");

	const dirty = run(["seed", "--headless", "--no-push"], bridge, "");
	assert.equal(dirty.status, 1);
	assert.match(dirty.stderr, /uncommitted changes/);
	assert.equal(readFileSync(memo, "utf8"), text, "a refused seed touches nothing");
});

test("seed keeps picker-level, and an old roots: or decks: key as it is", () => {
	const { bridge } = seededBridge(tmp, "roots", "pilot@nosedive.invalid");
	const backlog = configKey(bridge, "backlog");
	const configPath = join(bridge, ".nosedive", "config.yaml");
	write(configPath, `${config(bridge)}picker-level: 2\nroots: ${backlog}\ndecks: ${backlog}\n`);
	commitAll(bridge, "pilot keys");
	assertOk(run(["seed", "--headless", "--no-push"], bridge, ""), "seed failed");
	assert.equal(configKey(bridge, "picker-level"), "2");
	assert.equal(configKey(bridge, "roots"), backlog, "nothing reads roots:, and nothing renames it");
	assert.equal(configKey(bridge, "decks"), backlog);
	assert.equal(git(["status", "--porcelain"], bridge), "");
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
