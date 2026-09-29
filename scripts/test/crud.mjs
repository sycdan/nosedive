import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

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
		kindDoc(NOTE_KIND, "note", [
			"properties:",
			"  topic:",
			"    type: string",
			"  price:",
			"    type: number",
			"    minimum: 0",
		]),
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
	assert.equal(
		subject(bridge),
		`crud(${id}): created note ${id}`,
		"a minted doc is named by its id",
	);
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
	assert.equal(subject(bridge), `crud(${id}): created note sleeves`);
	const before = commits(bridge);

	const taken = run(["crud", "note", "--name", "sleeves", "Something", "else"], bridge);
	assert.equal(taken.status, 1);
	assert.match(taken.stderr, new RegExp(`note name sleeves is taken by ${id}`));
	assert.equal(commits(bridge), before);

	const slugged = run(["crud", "note", "--name", "Card Sleeves.Big Box", "x"], bridge);
	assertOk(slugged, "crud --name should slug a name");
	assert.match(
		readFileSync(join(bridge, "kb", `${madeId(slugged.stdout)}.md`), "utf8"),
		/^name: card-sleeves\.big-box$/m,
	);

	// A name is the identity: a second doc with the first one's gist is still minted.
	const twin = run(["crud", "note", "--name", "gloves", "Buy", "more", "sleeves"], bridge);
	assertOk(twin, "a named doc sharing a gist should mint");
	assert.match(
		readFileSync(join(bridge, "kb", `${madeId(twin.stdout)}.md`), "utf8"),
		/^name: gloves$/m,
	);

	const bad = run(["crud", "note", "--name", "sleeves..!", "y"], bridge);
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /nothing to slug/);

	const { bridge: seeded } = seededBridge(tmp, "named-deck", "pilot@nosedive.invalid");
	// A deck is named like any doc.
	const deck = run(["crud", "deck", "--name", "mtg", "Magic:", "The", "Gathering"], seeded);
	assertOk(deck, "crud deck --name failed");
	const seededConfig = readFileSync(join(seeded, ".nosedive", "config.yaml"), "utf8");
	const deckId = madeId(deck.stdout);
	const deckText = readFileSync(join(seeded, "kb", `${deckId}.md`), "utf8");
	assert.match(deckText, /^name: mtg$/m);
	assert.match(deckText, /^# Magic: The Gathering$/m);
	assert.match(seededConfig, new RegExp(`^decks: .*, ${deckId}$`, "m"));
	assert.equal(subject(seeded), `crud(${deckId}): created deck mtg`);
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

test("crud deck mints a deck and lists it in decks, in one commit", () => {
	const { bridge } = seededBridge(tmp, "decks", "pilot@nosedive.invalid");
	const config = () => readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const backlog = /^backlog: (\S+)$/m.exec(config())[1];

	const made = run(["crud", "deck", "Magic:", "The", "Gathering"], bridge);
	assertOk(made, "crud deck failed");
	const id = madeId(made.stdout);
	assert.ok(id, made.stdout);
	const text = readFileSync(join(bridge, "kb", `${id}.md`), "utf8");
	assert.match(text, /^kind: deck$/m);
	assert.match(text, new RegExp(`^name: ${id}$`, "m"));
	assert.match(text, /^# Magic: The Gathering$/m);
	// With no decks: yet, the backlog is written in first so it stays visible.
	assert.match(config(), new RegExp(`^decks: ${backlog}, ${id}$`, "m"));
	assert.equal(subject(bridge), `crud(${id}): created deck ${id}`);
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
	assert.equal(subject(worktree), `crud(${id}): created card ${id}`);
	assert.equal(git(["status", "--porcelain"], worktree), "");
	assert.equal(commits(bridge), bridgeBefore, "the bridge is untouched on a dive");

	const pinned = run(["crud", "--repo", "cards", "card", "Black", "Lotus"], bridge);
	assertOk(pinned, "crud --repo failed");
	assert.ok(existsSync(join(worktree, "kb", `${madeId(pinned.stdout)}.md`)));
	const elsewhere = run(["crud", "--repo", "nope", "card", "x"], bridge);
	assert.equal(elsewhere.status, 1);
	assert.match(elsewhere.stderr, /repo nope is not in context/);

	const read = run(["crud", id], bridge);
	assertOk(read, "crud <quid> on a dive failed");
	assert.match(read.stdout, /^gist: "Lightning Bolt"$/m);

	// A deck belongs to a bridge: minting one through a scoped repo's deck kind
	// must neither write to that repo nor reach past the dive into the bridge.
	const configBefore = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const worktreeBefore = commits(worktree);
	const deck = run(["crud", "deck", "Elves"], bridge);
	assert.equal(deck.status, 1, deck.stdout);
	assert.match(
		deck.stderr,
		/no kind deck in context/,
		"a deck kind outside a bridge is not in play",
	);
	assert.equal(commits(bridge), bridgeBefore);
	assert.equal(commits(worktree), worktreeBefore);
	assert.equal(git(["status", "--porcelain"], worktree), "", "the refused mint is undone");
	assert.equal(readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"), configBefore);

	const bridgeKind = run(["crud", "note", "x"], bridge);
	assert.equal(bridgeKind.status, 1);
	assert.match(bridgeKind.stderr, /no kind note/, "the bridge's kinds are not in play on a dive");
});

test("crud dive --feat records a planned dive with stdin as its brief, where the dive kind is", () => {
	const { bridge } = seededBridge(tmp, "dives", "pilot@nosedive.invalid");
	const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";
	const deck = /^backlog: (\S+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const made = run(
		[
			"crud",
			"dive",
			"--feat",
			KB_FEAT,
			"--deck",
			deck,
			"--title",
			"Note button",
			"Add",
			"the",
			"note",
			"button",
		],
		bridge,
		"Put a Note button in the dive bar.\n\nIt takes free text.\n",
	);
	assertOk(made, "crud dive failed");
	const path = /^Recorded (\S+)$/m.exec(made.stdout)?.[1];
	assert.ok(path, made.stdout);
	const doc = readFileSync(join(bridge, path), "utf8");
	assert.match(doc, /^kind: dive$/m);
	assert.match(doc, /^gist: "Add the note button"$/m);
	assert.match(doc, new RegExp(`^  feat: ${KB_FEAT}$`, "m"));
	assert.match(doc, /^  diver: null$/m, "recording claims nothing");
	assert.match(doc, new RegExp(`^  deck: ${deck}$`, "m"));
	assert.match(doc, /^# Note button$/m);
	assert.match(doc, /^## Brief\n\nPut a Note button in the dive bar\.\n\nIt takes free text\.$/m);
	assert.match(subject(bridge), /^dive\(\S+\): created$/);
	assert.ok(!existsSync(join(bridge, "workspace", ".nosedive-ref")), "nothing is on deck");

	for (const [args, pattern] of [
		[["dive", "No", "feat"], /crud dive needs --feat/],
		[["dive", "--feat", KB_FEAT, "--name", "mine", "Named"], /a dive's name is managed/],
		[["deck", "--feat", KB_FEAT, "Elves"], /--feat, --title and --deck go with crud dive/],
		[["dive", "--feat", KB_FEAT, "--deck", "nope", "Lost"], /no deck nope/],
	]) {
		const refused = run(["crud", ...args], bridge, "brief\n");
		assert.equal(refused.status, 1, args.join(" "));
		assert.match(refused.stderr, pattern);
	}
});

/** A doc's text with its meta block taken out, to show nothing else moved. */
const withoutMeta = (text) => text.replace(/^meta:\n(?:[ \t].*\n)*/m, "");

test("crud <quid> --meta - merges stdin into the doc's meta, validated, touching nothing else", () => {
	const bridge = bridgeWithKinds("meta");
	const id = madeId(run(["crud", "note", "Sleeves"], bridge).stdout);
	const path = join(bridge, "kb", `${id}.md`);
	const original = readFileSync(path, "utf8");

	const first = run(["crud", id, "--meta", "-"], bridge, "topic: sleeves\n");
	assertOk(first, "crud --meta failed");
	assert.match(first.stdout, /^Updated \S*kb[\\/][0-9a-f-]{36}\.md$/m);
	let text = readFileSync(path, "utf8");
	assert.match(text, /^meta:\n {2}topic: sleeves\n/m);
	assert.equal(withoutMeta(text), original, "only the meta block changed");
	assert.equal(subject(bridge), `crud(${id}): updated note ${id}`);
	assert.equal(git(["status", "--porcelain"], bridge), "");

	assertOk(run(["crud", id, "--meta", "-"], bridge, "price: 3\n"), "second merge failed");
	text = readFileSync(path, "utf8");
	assert.match(text, /^ {2}topic: sleeves$/m, "a merge keeps what it does not name");
	assert.match(text, /^ {2}price: 3$/m);

	assertOk(run(["crud", id, "--meta", "-"], bridge, "topic: null\n"), "removal failed");
	text = readFileSync(path, "utf8");
	assert.doesNotMatch(text, /topic/, "null removes a key");
	assert.match(text, /^ {2}price: 3$/m);

	const before = commits(bridge);
	for (const [input, pattern] of [
		["price: -1\n", /\/price/],
		["colour: red\n", /colour/],
		["- a\n", /mapping/],
	]) {
		const refused = run(["crud", id, "--meta", "-"], bridge, input);
		assert.equal(refused.status, 1, input);
		assert.match(refused.stderr, pattern);
	}
	assert.equal(readFileSync(path, "utf8"), text, "a refused merge writes nothing");
	assert.equal(commits(bridge), before);

	assertOk(run(["crud", id, "--meta", "-"], bridge, '{"topic": "json"}'), "a JSON patch failed");
	assert.match(readFileSync(path, "utf8"), /^ {2}topic: json$/m, "JSON is read as YAML");

	assertOk(
		run(["crud", id, "--meta", "-", "--replace"], bridge, "topic: only\n"),
		"--replace failed",
	);
	text = readFileSync(path, "utf8");
	assert.match(
		text,
		/^meta:\n {2}topic: only\n---/m,
		"--replace drops what the patch does not name",
	);

	const noValue = run(["crud", id, "--meta"], bridge, "");
	assert.equal(noValue.status, 1);
	assert.match(noValue.stderr, /--meta -/);
});

test("crud --meta puts a new meta block where KINGSMetaL order wants it", () => {
	const bridge = bridgeWithKinds("meta-order");
	const id = SPARE;
	const path = join(bridge, "kb", `${id}.md`);
	write(
		path,
		`---\nkind: note\nid: ${id}\nname: linked\ngist: "Linked"\nlinks:\n  - kb/${NOTE_KIND}.md\n---\n\n# Linked\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "linked note");
	assertOk(run(["crud", id, "--meta", "-"], bridge, "topic: order\n"), "crud --meta failed");
	assert.equal(
		readFileSync(path, "utf8"),
		`---\nkind: note\nid: ${id}\nname: linked\ngist: "Linked"\nmeta:\n  topic: order\nlinks:\n  - kb/${NOTE_KIND}.md\n---\n\n# Linked\n`,
	);
});

test("crud --meta merges nested mappings key by key", () => {
	const bridge = createBridge(tmp, "meta-nested");
	const id = SPARE;
	const path = join(bridge, "kb", `${id}.md`);
	write(
		path,
		`---\nkind: loose\nid: ${id}\nname: nested\ngist: "Nested"\nmeta:\n  box:\n    keep: 1\n    drop: 2\n---\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "nested");
	assertOk(
		run(["crud", id, "--meta", "-"], bridge, "box: {drop: null, add: 3}\n"),
		"nested merge failed",
	);
	assert.match(readFileSync(path, "utf8"), /^meta:\n {2}box:\n {4}keep: 1\n {4}add: 3\n---/m);
});

test("crud --scopes and --links patch one entry by its target, in KINGSMetaL order", () => {
	const bridge = createBridge(tmp, "blocks");
	const id = SPARE;
	const path = join(bridge, "kb", `${id}.md`);
	write(
		join(bridge, "kb", `${CARDS_REPO}.md`),
		`---\nkind: repo\nid: ${CARDS_REPO}\nname: cards\ngist: "Cards"\nmeta:\n  path: workspace/cards\n---\n`,
	);
	write(
		path,
		`---\nkind: memo\nid: ${id}\nname: plan\ngist: "Plan"\nmeta:\n  topic: x\n---\n\n# Plan\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "plan");
	const read = () => readFileSync(path, "utf8");

	assertOk(
		run(["crud", id, "--scopes", "-"], bridge, "cards: {}\n"),
		"adding a scope by repo name failed",
	);
	assert.match(
		read(),
		new RegExp(`gist: "Plan"\\nscopes:\\n {2}- ${CARDS_REPO}\\nmeta:`),
		"bare, before meta",
	);
	assert.equal(subject(bridge), `crud(${id}): updated memo plan`);

	assertOk(
		run(["crud", id, "--scopes", "-"], bridge, `${CARDS_REPO}: {work-branch: work/cards}\n`),
		"changing a scope failed",
	);
	assert.match(
		read(),
		new RegExp(`scopes:\\n {2}- ${CARDS_REPO}:\\n {6}work-branch: work/cards\\n`),
	);

	assertOk(
		run(["crud", id, "--links", "-"], bridge, `${DIVE}: {rel: mtg.feat}\n`),
		"linking a quid failed",
	);
	assertOk(
		run(["crud", id, "--links", "-"], bridge, "https://example.com: {}\n"),
		"linking a URL failed",
	);
	assert.match(
		read(),
		new RegExp(
			`meta:\\n {2}topic: x\\nlinks:\\n {2}- kb/${DIVE}.md:\\n {6}rel: mtg.feat\\n {2}- https://example.com\\n---`,
		),
		"links last, a quid as its kb path, new entries after old",
	);

	assertOk(run(["crud", id, "--scopes", "-"], bridge, "cards: null\n"), "removing a scope failed");
	assert.doesNotMatch(read(), /^scopes:/m, "an emptied block is removed");

	assertOk(
		run(["crud", id, "--links", "-", "--replace"], bridge, "https://example.org: {}\n"),
		"--replace failed",
	);
	assert.match(read(), /^links:\n {2}- https:\/\/example\.org\n---/m);

	const before = commits(bridge);
	for (const [args, input, pattern] of [
		[["--scopes", "-"], "nowhere: {}\n", /no repo named nowhere/],
		[["--scopes", "-", "--links", "-"], "a: {}\n", /one block at a time/],
		[["--replace"], "", /--replace goes with/],
	]) {
		const refused = run(["crud", id, ...args], bridge, input);
		assert.equal(refused.status, 1, args.join(" "));
		assert.match(refused.stderr, pattern);
	}
	assert.equal(commits(bridge), before, "a refused patch commits nothing");
});
