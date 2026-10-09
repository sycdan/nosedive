import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

test("seed keeps only the kb feat in the bridge, scopes it, and links it from the backlog", () => {
	const { bridge } = seededBridge(tmp, "fresh", "pilot@nosedive.invalid");
	const kb = join(bridge, "kb");
	assert.deepEqual(zerostars(kb), [`${KB_FEAT}.md`]);
	for (const id of [KIND, MEMO, DIVE, REPO]) {
		assert.equal(existsSync(join(kb, `${id}.md`)), false);
		const shown = run(["crud", id], bridge);
		assertOk(shown, `crud ${id} failed`);
		assert.equal(shown.stdout, readFileSync(join(root, "kb", `${id}.md`), "utf8"));
	}

	const feat = readFileSync(join(kb, `${KB_FEAT}.md`), "utf8");
	const self = configKey(bridge, "bridge");
	assert.match(
		feat,
		new RegExp(
			`^scopes:\\n {2}- ${self}:\\n {6}work-branch: fresh-main/${KB_FEAT}-${KB_FEAT}$`,
			"m",
		),
	);
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
	const linked = run(["crud", "memo", "Linked", "memo"], bridge);
	assertOk(linked, "crud memo failed");
	const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(linked.stdout)?.[1];
	assertOk(
		run(["crud", id, "--links", "-"], bridge, `${KIND}: {rel: reference}\n`),
		"a link to a package kind resolves without a bridge file",
	);
});

test("seed removes a built-in copy identical to the last seed and leaves the kb feat alone", () => {
	const { bridge } = seededBridge(tmp, "merge", "pilot@nosedive.invalid");
	const memo = join(bridge, "kb", `${MEMO}.md`);
	write(memo, readFileSync(join(root, "kb", `${MEMO}.md`), "utf8"));
	commitAll(bridge, "seed(nosedive@old): surface did not change");
	const feat = join(bridge, "kb", `${KB_FEAT}.md`);
	write(feat, `${readFileSync(feat, "utf8")}\nOur notes.\n`);
	commitAll(bridge, "our kb notes");

	const seeded = run(["seed", "--headless", "--no-push"], bridge, "");
	assertOk(seeded, "seed failed");
	assert.match(seeded.stdout, new RegExp(`Removed kb[\\\\/]${MEMO}\\.md`));
	assert.equal(existsSync(memo), false);
	assert.match(readFileSync(feat, "utf8"), /Our notes\./, "a create-only doc is never merged");
	assert.equal(git(["status", "--porcelain"], bridge), "");
});

test("seed leaves an edited built-in copy in place and ignores it for crud and validation", () => {
	const { bridge } = seededBridge(tmp, "conflict", "pilot@nosedive.invalid");
	const memo = join(bridge, "kb", `${MEMO}.md`);
	const shipped = readFileSync(join(root, "kb", `${MEMO}.md`), "utf8");
	write(memo, shipped);
	commitAll(bridge, "seed(nosedive@old): surface did not change");
	write(
		memo,
		shipped
			.replace("# Memo", "# Our Memo")
			.replace("additionalProperties: true", "additionalProperties: false"),
	);
	commitAll(bridge, "our heading");
	const before = commits(bridge);
	const seeded = run(["seed", "--headless", "--no-push"], bridge, "");
	assertOk(seeded, "seed failed");
	assert.match(seeded.stdout, /Kept edited built-in kind/);
	assert.equal(commits(bridge), before);
	assert.match(readFileSync(memo, "utf8"), /# Our Memo/);
	assert.equal(run(["crud", MEMO], bridge).stdout, shipped, "crud reads the package copy");
	const made = run(["crud", "memo", "Valid", "memo"], bridge);
	assertOk(made, "crud memo failed");
	const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(made.stdout)?.[1];
	assertOk(
		run(["crud", id, "--meta", "-"], bridge, "extra: allowed\n"),
		"validation uses the package's open schema",
	);
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
