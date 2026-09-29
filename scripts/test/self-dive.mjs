import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createTmp, libUrl, run, runTool, seededBridge } from "../test-helpers.mjs";

const { helmCreatableKinds, helmDecks } = await import(libUrl);
const tmp = createTmp("self-dive");
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

test("a deck made on a dive that scopes the bridge goes to its __self checkout, and the live bridge is untouched", () => {
	const { bridge, origin } = seededBridge(tmp, "self", "pilot@nosedive.invalid");
	const configPath = join(bridge, ".nosedive", "config.yaml");
	const liveConfig = readFileSync(configPath, "utf8");

	// The kb feat scopes the bridge itself, so jumping a dive on it hydrates __self.
	const recorded = run(
		["crud", "dive", "--feat", KB_FEAT, "Add", "a", "deck"],
		bridge,
		"Make a deck.\n",
	);
	assertOk(recorded, "crud dive failed");
	const divePath = /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1];
	assertOk(run(["jump", divePath], bridge), "jump failed");
	const self = join(bridge, "workspace", "__self");

	// The dive bar offers what the dive can make: the bridge's kinds, but no dive kind.
	assert.deepEqual(
		helmCreatableKinds(bridge).map((kind) => `${kind.repoName}:${kind.name}`),
		["self:deck", "self:kind", "self:memo"],
	);
	assert.ok(helmCreatableKinds(bridge)[1].schema, "each kind carries its schema for the form");

	const made = run(["crud", "deck", "--name", "Magic Cards", "Cards", "I", "own"], bridge);
	assertOk(made, "crud deck failed");
	const deckId = /Minted \S*?([0-9a-f-]{36})\.md/.exec(made.stdout)?.[1];
	assert.match(made.stdout, /Listed \S+ in workspace[\\/]__self[\\/]\.nosedive[\\/]config\.yaml/);

	// Helm shows the bridge as the dive has it: the new deck already, the kb feat first at the root.
	const view = helmDecks(bridge);
	assert.equal(view.diving, true);
	assert.deepEqual(
		view.decks.map((deck) => deck.id),
		[deckId],
	);
	assert.equal(view.feats[0].id, KB_FEAT);
	const backlog = /^backlog: (\S+)$/m.exec(liveConfig)[1];
	assert.equal(view.locked, true, "on a dive the deck is the dive's");
	assert.equal(view.deck, backlog, "a dive naming no deck is on the bridge deck");
	assert.equal(helmDecks(bridge, deckId).deck, backlog, "a pick cannot move a locked deck");

	// A dive planned on the dive -- on the very feat being dived, which jump has
	// just edited in the live bridge -- is written and committed in __self too,
	// claims nothing, and lands without a conflict.
	const featId = KB_FEAT;
	const planned = run(
		["crud", "dive", "--feat", featId, "--title", "Next", "Plan", "the", "next", "one"],
		bridge,
		"Do the next thing.\n",
	);
	assertOk(planned, "crud dive on a dive failed");
	const plannedPath = /^Recorded (\S+)$/m.exec(planned.stdout)?.[1];
	assert.match(plannedPath, /^workspace[\\/]__self[\\/]kb[\\/]/);
	assert.match(planned.stdout, /nosedive land/);
	const plannedId = /([0-9a-f-]{36})\.md$/.exec(plannedPath)[1];
	assert.match(git(["log", "-1", "--format=%s"], self), /^dive\(\S+\): created$/);
	assert.match(
		readFileSync(join(self, "kb", `${featId}.md`), "utf8"),
		new RegExp(`${plannedId}\\.md:\\n\\s+rel: planned\\.dive`),
		"linked from the feat in __self",
	);
	assert.equal(git(["status", "--porcelain"], self), "");
	assert.match(
		readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"),
		new RegExp(/[0-9a-f-]{36}/.exec(divePath)[0]),
		"the dive on deck is still the one jumped",
	);

	assert.match(
		readFileSync(join(self, ".nosedive", "config.yaml"), "utf8"),
		new RegExp(`^decks: .*${deckId}$`, "m"),
		"listed in the checkout's own config",
	);
	assert.deepEqual(
		git(["show", "--name-only", "--format=", "HEAD~1"], self).split(/\r?\n/).sort(),
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
	assert.match(readFileSync(join(bridge, "kb", `${plannedId}.md`), "utf8"), /^# Next$/m);
	assert.equal(git(["status", "--porcelain", "--", ".nosedive", "kb"], bridge), "");

	assert.deepEqual(helmCreatableKinds(bridge), [], "with no dive helm makes nothing");

	// With no dive the pilot picks: the deck is theirs, and its feats are its own.
	const picked = helmDecks(bridge, deckId);
	assert.equal(picked.locked, false);
	assert.equal(picked.deck, deckId);
	assert.deepEqual(picked.feats, [], "the new deck links no feats yet");
	assert.equal(helmDecks(bridge, "not-a-deck").deck, backlog, "an unknown pick falls back");
});

test("the bridge's own scope lands alongside commits the live bridge holds, and a conflict writes nothing", () => {
	const { bridge, origin } = seededBridge(tmp, "self-ahead", "pilot@nosedive.invalid");
	const recorded = run(
		["crud", "dive", "--feat", KB_FEAT, "Add", "a", "deck"],
		bridge,
		"Make a deck.\n",
	);
	assertOk(recorded, "crud dive failed");
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

test("a second dive on the bridge lands only its own work, after the first landed through a merge", () => {
	const { bridge, origin } = seededBridge(tmp, "self-twice", "pilot@nosedive.invalid");
	const dive = (name) => {
		assertOk(run(["jump", KB_FEAT], bridge), "jump failed");
		assertOk(run(["crud", "deck", "--name", name, name], bridge), "crud deck failed");
		// Edit the dived feat too: the first dive's bookkeeping touched it, and so did jump's.
		assertOk(
			run(["crud", KB_FEAT, "--meta", "-"], bridge, `note: ${name}\n`),
			"crud --meta on the kb feat failed",
		);
		const landed = run(["land"], bridge);
		assertOk(landed, `land of ${name} failed`);
	};
	dive("first");
	dive("second");
	const published = git(["log", "--format=%s", "main"], origin);
	assert.equal(published.match(/created deck first/g)?.length, 1, "the first deck lands once");
	assert.equal(published.match(/created deck second/g)?.length, 1);
	assert.equal(git(["status", "--porcelain", "--", ".nosedive", "kb"], bridge), "");
});
