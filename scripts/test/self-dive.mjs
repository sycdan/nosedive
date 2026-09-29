import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

	// Land publishes the checkout's work branch; the live bridge's config still waits for it.
	assertOk(run(["land"], bridge), "land failed");
	assert.match(git(["show", "work/kb:.nosedive/config.yaml"], origin), new RegExp(deckId));
	assert.equal(readFileSync(configPath, "utf8"), liveConfig);
});
