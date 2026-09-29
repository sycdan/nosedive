import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createTmp, run, runTool, seededBridge } from "../test-helpers.mjs";

const tmp = createTmp("self-dive");
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

test("a deck made on a dive that scopes the bridge goes to its __self checkout, and the live bridge is untouched", () => {
	const { bridge, origin } = seededBridge(tmp, "self", "pilot@nosedive.invalid");
	const configPath = join(bridge, ".nosedive", "config.yaml");
	const liveConfig = readFileSync(configPath, "utf8");

	// The kb feat scopes the bridge itself, so jumping a dive on it hydrates __self.
	const recorded = run(["dive", KB_FEAT, "Add", "a", "deck"], bridge, "Make a deck.\n");
	assertOk(recorded, "dive failed");
	const divePath = /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1];
	assertOk(run(["jump", divePath], bridge), "jump failed");
	const self = join(bridge, "workspace", "__self");

	const made = run(["crud", "deck", "--name", "Magic Cards", "Cards", "I", "own"], bridge);
	assertOk(made, "crud deck failed");
	const deckId = /Minted \S*?([0-9a-f-]{36})\.md/.exec(made.stdout)?.[1];
	assert.match(made.stdout, /Listed \S+ in workspace[\\/]__self[\\/]\.nosedive[\\/]config\.yaml/);

	assert.match(
		readFileSync(join(self, ".nosedive", "config.yaml"), "utf8"),
		new RegExp(`^decks: .*${deckId}$`, "m"),
		"listed in the checkout's own config",
	);
	assert.deepEqual(
		git(["show", "--name-only", "--format=", "HEAD"], self).split(/\r?\n/).sort(),
		[".nosedive/config.yaml", `kb/${deckId}.md`],
		"the deck and its listing are one commit in __self",
	);
	assert.equal(
		readFileSync(configPath, "utf8"),
		liveConfig,
		"the live bridge's config is untouched",
	);
	assert.equal(git(["status", "--porcelain", "--", ".nosedive", "kb"], bridge), "");

	// Land pushes the checkout to its work branch and brings it into the live bridge, which publishes it.
	const landed = run(["land"], bridge);
	assertOk(landed, "land failed");
	assert.match(landed.stderr, /brought the bridge's own scope into the bridge/);
	assert.match(git(["show", "work/kb:.nosedive/config.yaml"], origin), new RegExp(deckId));
	assert.match(git(["show", "main:.nosedive/config.yaml"], origin), new RegExp(deckId));
	assert.match(readFileSync(configPath, "utf8"), new RegExp(`^decks: .*${deckId}$`, "m"));
	assert.match(readFileSync(join(bridge, "kb", `${deckId}.md`), "utf8"), /^name: magic-cards$/m);
	assert.equal(git(["status", "--porcelain", "--", ".nosedive", "kb"], bridge), "");
});

test("the bridge's own scope lands alongside commits the live bridge holds, and a conflict writes nothing", () => {
	const { bridge, origin } = seededBridge(tmp, "self-ahead", "pilot@nosedive.invalid");
	const recorded = run(["dive", KB_FEAT, "Add", "a", "deck"], bridge, "Make a deck.\n");
	assertOk(recorded, "dive failed");
	assertOk(run(["jump", /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1]], bridge), "jump failed");
	const self = join(bridge, "workspace", "__self");
	assertOk(run(["crud", "deck", "--name", "ideas", "Ideas"], bridge), "crud deck failed");

	// A local-only bridge commit adding the same file the dive adds conflicts.
	writeFileSync(join(bridge, "shared.md"), "the live bridge says one thing\n");
	runTool("git", ["add", "shared.md"], bridge);
	runTool("git", ["commit", "-m", "live edit"], bridge);
	writeFileSync(join(self, "shared.md"), "the dive says another\n");
	runTool("git", ["add", "shared.md"], self);
	runTool("git", ["commit", "-m", "dive edit"], self);
	const head = git(["rev-parse", "HEAD"], bridge);
	const refused = run(["land"], bridge);
	assert.equal(refused.status, 1, refused.stdout);
	assert.match(refused.stderr, /does not apply to the bridge/);
	assert.match(refused.stderr, /shared\.md/);
	assert.equal(git(["rev-parse", "HEAD"], bridge), head, "the live bridge is as it was");
	assert.equal(git(["status", "--porcelain", "--", "shared.md"], bridge), "");

	// Without the conflict, the live bridge's own commit and the dive's publish together.
	runTool("git", ["reset", "--hard", "HEAD~1"], bridge);
	writeFileSync(join(bridge, "local.md"), "only here\n");
	runTool("git", ["add", "local.md"], bridge);
	runTool("git", ["commit", "-m", "local only"], bridge);
	const landed = run(["land"], bridge);
	assertOk(landed, "land failed");
	const published = git(["log", "--format=%s", "main"], origin);
	assert.match(published, /local only/);
	assert.match(published, /created deck ideas/);
	assert.match(published, /dive edit/);
});
