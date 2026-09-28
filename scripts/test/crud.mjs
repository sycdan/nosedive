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
	implRepo,
	root,
	run,
	runTool,
	seededBridge,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const tmp = createTmp("crud");
const minted = run(["mint", "6"], tmp);
assertOk(minted, "mint failed");
const [NOTE_KIND, NEEDY_KIND, CARD_KIND, CARDS_REPO, DIVE, SPARE] = minted.stdout
	.trim()
	.split(/\r?\n/);

function kindDoc(id, name, schemaLines) {
	return [
		"---",
		"kind: kind",
		`id: ${id}`,
		`name: ${name}`,
		`gist: "The ${name} kind"`,
		"meta:",
		"  schema:",
		"    type: object",
		"    additionalProperties: false",
		...schemaLines.map((line) => `    ${line}`),
		"---",
		"",
	].join("\n");
}

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();
const subject = (cwd) => git(["log", "-1", "--format=%s"], cwd);
const commits = (cwd) => git(["rev-list", "--count", "HEAD"], cwd);
const madeId = (stdout) => /^Minted (?:\S*[\\/])?kb[\\/]([0-9a-f-]{36})\.md$/m.exec(stdout)?.[1];

function bridgeWithKinds(name) {
	const bridge = createBridge(tmp, name);
	write(
		join(bridge, "kb", `${NOTE_KIND}.md`),
		kindDoc(NOTE_KIND, "note", ["properties:", "  topic:", "    type: string"]),
	);
	write(
		join(bridge, "kb", `${NEEDY_KIND}.md`),
		kindDoc(NEEDY_KIND, "needy", [
			"required: [owner]",
			"properties:",
			"  owner:",
			"    type: string",
		]),
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "kinds");
	return bridge;
}

test("crud with no arguments fails and shows its help", () => {
	const bridge = bridgeWithKinds("help");
	const result = run(["crud"], bridge);
	assert.equal(result.status, 1);
	assert.match(result.stdout + result.stderr, /Usage: nosedive crud/);
});

test("crud mints a doc of a bridge kind, then reads it on the next run", () => {
	const bridge = bridgeWithKinds("mint-read");
	const first = run(["crud", "note", "Buy", "more", "sleeves"], bridge);
	assertOk(first, "crud mint failed");
	const id = madeId(first.stdout);
	assert.ok(id, first.stdout);
	const text = readFileSync(join(bridge, "kb", `${id}.md`), "utf8");
	assert.match(
		text,
		new RegExp(`^---\nkind: note\nid: ${id}\nname: ${id}\ngist: "Buy more sleeves"\n---\n`),
	);
	assert.equal(subject(bridge), `crud(${id}): created ${id}`, "a minted doc is named by its id");
	assert.equal(git(["status", "--porcelain"], bridge), "");
	const before = commits(bridge);

	const second = run(["crud", "note", "buy more sleeves"], bridge);
	assertOk(second, "crud read failed");
	assert.equal(second.stdout, text, "reading prints the doc as it is");
	assert.equal(commits(bridge), before, "reading writes nothing");

	const byGist = run(["crud", "note", "BUY MORE SLEEVES"], bridge);
	assertOk(byGist, "crud read by gist failed");
	assert.equal(byGist.stdout, text);

	const byQuid = run(["crud", id], bridge);
	assertOk(byQuid, "crud <quid> failed");
	assert.equal(byQuid.stdout, text);
});

test("crud --name names the minted doc, once per kind in its repo", () => {
	const bridge = bridgeWithKinds("named");
	const made = run(["crud", "note", "--name", "sleeves", "Buy", "more", "sleeves"], bridge);
	assertOk(made, "crud --name failed");
	const id = madeId(made.stdout);
	const text = readFileSync(join(bridge, "kb", `${id}.md`), "utf8");
	assert.match(text, /^name: sleeves$/m);
	assert.match(text, /^gist: "Buy more sleeves"$/m);
	assert.equal(subject(bridge), `crud(${id}): created sleeves`);
	const before = commits(bridge);

	const taken = run(["crud", "note", "--name", "sleeves", "Something", "else"], bridge);
	assert.equal(taken.status, 1);
	assert.match(taken.stderr, new RegExp(`note name sleeves is taken by ${id}`));
	assert.equal(commits(bridge), before);

	const bad = run(["crud", "note", "--name", "Not A Name", "x"], bridge);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /kebab-case/);

	const { bridge: seeded } = seededBridge(tmp, "named-deck", "pilot@nosedive.invalid");
	const deck = run(["crud", "deck", "--name", "elves", "Elves"], seeded);
	assert.equal(deck.status, 1);
	assert.match(deck.stderr, /crud-script, which names the doc itself/);
});

test("crud refuses an ambiguous match, an unknown kind, and a mint its kind would reject", () => {
	const bridge = bridgeWithKinds("refusals");
	const [a, b] = [SPARE, DIVE];
	for (const id of [a, b])
		write(
			join(bridge, "kb", `${id}.md`),
			`---\nkind: note\nid: ${id}\nname: dupe\ngist: "Dupe"\n---\n`,
		);
	const ambiguous = run(["crud", "note", "dupe"], bridge);
	assert.equal(ambiguous.status, 1);
	assert.ok(ambiguous.stderr.includes(a) && ambiguous.stderr.includes(b), ambiguous.stderr);
	assert.match(ambiguous.stderr, /quid/);

	const unknown = run(["crud", "widget", "x"], bridge);
	assert.equal(unknown.status, 1);
	assert.match(unknown.stderr, /no kind widget/);

	const before = commits(bridge);
	const needy = run(["crud", "needy", "Nobody owns this"], bridge);
	assert.equal(needy.status, 1);
	assert.match(needy.stderr, /owner/);
	assert.equal(commits(bridge), before, "an invalid mint writes nothing");
	assert.deepEqual(
		git(["status", "--porcelain", "kb"], bridge).split("\n").sort(),
		[`?? kb/${a}.md`, `?? kb/${b}.md`].sort(),
		"only the two hand-written dupes are new",
	);
});

test("crud deck mints through the deck kind's script: deterministic id and decks entry in one commit", () => {
	const { bridge } = seededBridge(tmp, "decks", "pilot@nosedive.invalid");
	const config = () => readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const bridgeId = /^bridge: (\S+)$/m.exec(config())[1];
	const backlog = /^backlog: (\S+)$/m.exec(config())[1];

	const made = run(["crud", "deck", "Magic:", "The", "Gathering"], bridge);
	assertOk(made, "crud deck failed");
	const id = namespacedUuid(bridgeId, "magic-the-gathering");
	assert.equal(madeId(made.stdout), id);
	const text = readFileSync(join(bridge, "kb", `${id}.md`), "utf8");
	assert.match(text, /^kind: deck$/m);
	assert.match(text, /^name: magic-the-gathering$/m);
	assert.match(text, /^# Magic: The Gathering$/m);
	assert.match(config(), new RegExp(`^decks: ${backlog}, magic-the-gathering$`, "m"));
	assert.equal(subject(bridge), `crud(${id}): created magic-the-gathering`);
	assert.deepEqual(
		git(["show", "--name-only", "--format=", "HEAD"], bridge).split(/\r?\n/).sort(),
		[".nosedive/config.yaml", `kb/${id}.md`],
	);

	const read = run(["crud", "deck", "magic the gathering"], bridge);
	assertOk(read, "crud deck read failed");
	assert.equal(read.stdout, text);
});

test("on a dive crud works only in the scoped repos, and commits where the kind lives", () => {
	const bridge = bridgeWithKinds("dive");
	const cards = implRepo(tmp, "cards");
	write(
		join(cards.source, "kb", `${CARD_KIND}.md`),
		kindDoc(CARD_KIND, "card", ["properties: {}"]),
	);
	// The repo carries the deck kind too -- as nosedive's own repo does -- but is no bridge.
	const DECK_FILE = "00000000-0000-7d1f-805a-7d0a3bdff309.md";
	write(join(cards.source, "kb", DECK_FILE), readFileSync(join(root, "kb", DECK_FILE), "utf8"));
	runTool("git", ["add", "."], cards.source);
	gitCommit(cards.source, "card kind");
	runTool("git", ["push", "cloud", "main"], cards.source);
	writeImplRepoDoc(bridge, CARDS_REPO, cards);
	write(
		join(bridge, "kb", `${DIVE}.md`),
		`---\nkind: dive\nid: ${DIVE}\nname: the-dive\ngist: "A dive"\nscopes:\n  - ${CARDS_REPO}\n---\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	assertOk(run(["hydrate-repo.workspace", CARDS_REPO], bridge), "hydrate failed");
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${DIVE}\n`);
	const worktree = join(bridge, "workspace", "cards");
	const bridgeBefore = commits(bridge);

	const made = run(["crud", "card", "Lightning", "Bolt"], bridge);
	assertOk(made, "crud card failed");
	const id = madeId(made.stdout);
	assert.ok(
		existsSync(join(worktree, "kb", `${id}.md`)),
		"minted in the repo that defines the kind",
	);
	assert.equal(subject(worktree), `crud(${id}): created ${id}`);
	assert.equal(git(["status", "--porcelain"], worktree), "");
	assert.equal(commits(bridge), bridgeBefore, "the bridge is untouched on a dive");

	const read = run(["crud", id], bridge);
	assertOk(read, "crud <quid> on a dive failed");
	assert.match(read.stdout, /^gist: "Lightning Bolt"$/m);

	// A deck belongs to a bridge: minting one through a scoped repo's deck kind
	// must neither write to that repo nor reach past the dive into the bridge.
	const configBefore = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const worktreeBefore = commits(worktree);
	const deck = run(["crud", "deck", "Elves"], bridge);
	assert.equal(deck.status, 1, deck.stdout);
	assert.match(deck.stderr, /not a nosedive bridge/);
	assert.equal(commits(bridge), bridgeBefore);
	assert.equal(commits(worktree), worktreeBefore);
	assert.equal(readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"), configBefore);

	const bridgeKind = run(["crud", "note", "x"], bridge);
	assert.equal(bridgeKind.status, 1);
	assert.match(bridgeKind.stderr, /no kind note/, "the bridge's kinds are not in play on a dive");
});
