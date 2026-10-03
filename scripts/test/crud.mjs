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

test("a new doc takes its meta whole from stdin, validated; a new kind starts with a closed schema", () => {
	const bridge = bridgeWithKinds("mint-meta");
	const owned = run(
		["crud", "needy", "--meta", "-", "Somebody", "owns", "this"],
		bridge,
		"owner: pilot\n",
	);
	assertOk(owned, "crud needy --meta failed");
	const doc = readFileSync(join(bridge, "kb", `${madeId(owned.stdout)}.md`), "utf8");
	assert.match(doc, /^meta:\n {2}owner: pilot\n---$/m);

	const before = commits(bridge);
	const bad = run(["crud", "note", "--meta", "-", "Priced", "wrong"], bridge, "price: -1\n");
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /\/price/);
	assert.equal(commits(bridge), before, "an invalid mint writes nothing");
	const taken = run(["crud", "note", "--meta", "-", "Priced", "wrong"], bridge, "{}\n");
	assertOk(taken, "crud note --meta {} failed");
	const again = run(["crud", "note", "--meta", "-", "Priced", "wrong"], bridge, "topic: x\n");
	assert.equal(again.status, 1);
	assert.match(again.stderr, /already has that gist; patch its meta/);

	write(
		join(bridge, "kb", "00000000-0000-70a0-90bd-1d49dc6264b9.md"),
		readFileSync(join(root, "kb", "00000000-0000-70a0-90bd-1d49dc6264b9.md"), "utf8"),
	);
	const kind = run(["crud", "kind", "--name", "bug", "A", "defect"], bridge);
	assertOk(kind, "crud kind failed");
	const kindText = readFileSync(join(bridge, "kb", `${madeId(kind.stdout)}.md`), "utf8");
	assert.match(
		kindText,
		/^meta:\n {2}schema:\n {4}type: object\n {4}additionalProperties: false\n {4}properties: \{\}\n---$/m,
	);
});

test("crud deck is an unknown kind, and touches nothing", () => {
	const { bridge } = seededBridge(tmp, "decks", "pilot@nosedive.invalid");
	const config = () => readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const configBefore = config();
	const before = commits(bridge);

	const made = run(["crud", "deck", "Magic:", "The", "Gathering"], bridge);
	assert.equal(made.status, 1, made.stdout);
	assert.match(made.stderr, /no kind deck in context/);
	assert.equal(commits(bridge), before);
	assert.equal(config(), configBefore);
	assert.equal(git(["status", "--porcelain"], bridge), "");
});

test("on a dive crud works only in the scoped repos, and commits where the kind lives", () => {
	const bridge = bridgeWithKinds("dive");
	const cards = implRepo(tmp, "cards");
	write(
		join(cards.source, "kb", `${CARD_KIND}.md`),
		kindDoc(CARD_KIND, "card", ["properties: {}"]),
	);
	// The repo carries the dive kind too -- as nosedive's own repo does -- but is no bridge.
	const DIVE_KIND_FILE = "00000000-0000-77cb-bcfe-6c9fb07f42ab.md";
	write(
		join(cards.source, "kb", DIVE_KIND_FILE),
		readFileSync(join(root, "kb", DIVE_KIND_FILE), "utf8"),
	);
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

	const pinned = run(["crud", "cards:card", "Black", "Lotus"], bridge);
	assertOk(pinned, "crud <repo>:<kind> failed");
	assert.ok(existsSync(join(worktree, "kb", `${madeId(pinned.stdout)}.md`)));
	const elsewhere = run(["crud", "nope:card", "x"], bridge);
	assert.equal(elsewhere.status, 1);
	assert.match(elsewhere.stderr, /repo nope is not in context/);

	const read = run(["crud", id], bridge);
	assertOk(read, "crud <quid> on a dive failed");
	assert.match(read.stdout, /^gist: "Lightning Bolt"$/m);

	// A dive belongs to a bridge: recording one through a scoped repo's dive kind
	// must neither write to that repo nor reach past the dive into the bridge.
	const configBefore = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const worktreeBefore = commits(worktree);
	const dive = run(["crud", "dive", "--feat", id, "Elves"], bridge, "A brief.\n");
	assert.equal(dive.status, 1, dive.stdout);
	assert.match(
		dive.stderr,
		/no kind dive in context/,
		"a dive kind outside a bridge is not in play",
	);
	assert.equal(commits(bridge), bridgeBefore);
	assert.equal(commits(worktree), worktreeBefore);
	assert.equal(git(["status", "--porcelain"], worktree), "", "the refused mint is undone");
	assert.equal(readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"), configBefore);

	const bridgeKind = run(["crud", "note", "x"], bridge);
	assert.equal(bridgeKind.status, 1);
	assert.match(bridgeKind.stderr, /no kind note/, "the bridge's kinds are not in play on a dive");
});

test("a kind two repos in play define is named <repo>:<kind>, and a doc's meta checks against its own repo's", () => {
	const ids = run(["mint", "5"], tmp);
	assertOk(ids, "mint failed");
	const [MEMO_A, MEMO_B, REPO_A, REPO_B, MEMO_DIVE] = ids.stdout.trim().split(/\r?\n/);
	const bridge = createBridge(tmp, "memo-bridge");
	const repoA = implRepo(tmp, "memos-a");
	const repoB = implRepo(tmp, "memos-b");
	for (const [repo, id, schema] of [
		[repoA, MEMO_A, ["properties:", "  topic:", "    type: string"]],
		[repoB, MEMO_B, ["properties:", "  price:", "    type: number"]],
	]) {
		write(join(repo.source, "kb", `${id}.md`), kindDoc(id, "memo", schema));
		runTool("git", ["add", "."], repo.source);
		gitCommit(repo.source, "memo kind");
		runTool("git", ["push", "cloud", "main"], repo.source);
	}
	writeImplRepoDoc(bridge, REPO_A, repoA);
	writeImplRepoDoc(bridge, REPO_B, repoB);
	write(
		join(bridge, "kb", `${MEMO_DIVE}.md`),
		`---\nkind: dive\nid: ${MEMO_DIVE}\nname: the-dive\ngist: "A dive"\nscopes:\n  - ${REPO_A}\n  - ${REPO_B}\n---\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	assertOk(run(["hydrate-repo.workspace", REPO_A], bridge), "hydrate failed");
	assertOk(run(["hydrate-repo.workspace", REPO_B], bridge), "hydrate failed");
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${MEMO_DIVE}\n`);
	const kbA = join(bridge, "workspace", "memos-a", "kb");
	const kbB = join(bridge, "workspace", "memos-b", "kb");

	const bare = run(["crud", "memo", "x"], bridge);
	assert.equal(bare.status, 1);
	assert.match(bare.stderr, /name one: memos-a:memo, memos-b:memo/);

	const byName = run(["crud", "memos-a:memo", "From", "A"], bridge);
	assertOk(byName, "crud <name>:memo failed");
	const idA = madeId(byName.stdout);
	assert.match(readFileSync(join(kbA, `${idA}.md`), "utf8"), /^kind: memo$/m);
	const byId = run(["crud", `${REPO_B}:memo`, "From", "B"], bridge);
	assertOk(byId, "crud <repo-id>:memo failed");
	const idB = madeId(byId.stdout);
	assert.match(readFileSync(join(kbB, `${idB}.md`), "utf8"), /^kind: memo$/m);

	// A bare quid finds the doc; its meta checks against its own repo's memo.
	assertOk(run(["crud", idB, "--meta", "-"], bridge, "price: 3\n"), "patching B's memo failed");
	const wrong = run(["crud", idB, "--meta", "-"], bridge, "topic: t\n");
	assert.equal(wrong.status, 1);
	assert.match(wrong.stderr, /would not validate/);

	// The same quid in both repos: the qualified ref patches that repo's copy.
	const copyB = join(kbB, `${idA}.md`);
	write(copyB, readFileSync(join(kbA, `${idA}.md`), "utf8"));
	const beforeA = readFileSync(join(kbA, `${idA}.md`), "utf8");
	assertOk(
		run(["crud", `memos-b:${idA}`, "--meta", "-"], bridge, "price: 7\n"),
		"memos-b:<quid> failed",
	);
	assert.match(readFileSync(copyB, "utf8"), /price: 7/);
	assert.equal(readFileSync(join(kbA, `${idA}.md`), "utf8"), beforeA);

	const flag = run(["crud", "--repo", "memos-a", "memo", "y"], bridge);
	assert.equal(flag.status, 1);
	assert.match(flag.stderr, /<repo>:<kind>/);
});

test("crud dive --feat records a planned dive with stdin as its brief, where the dive kind is", () => {
	const { bridge } = seededBridge(tmp, "dives", "pilot@nosedive.invalid");
	const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";
	const made = run(
		["crud", "dive", "--feat", KB_FEAT, "--title", "Note button", "Add", "the", "note", "button"],
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
	assert.doesNotMatch(doc, /^ {2}(root|deck):/m, "a dive keeps no root");
	assert.match(doc, /^# Note button$/m);
	assert.match(doc, /^## Brief\n\nPut a Note button in the dive bar\.\n\nIt takes free text\.$/m);
	assert.match(subject(bridge), /^dive\(\S+\): created$/);
	assert.ok(!existsSync(join(bridge, "workspace", ".nosedive-ref")), "nothing is on deck");

	for (const [args, pattern] of [
		[["dive", "No", "feat"], /crud dive needs --feat/],
		[["dive", "--feat", KB_FEAT, "--name", "mine", "Named"], /a dive's name is managed/],
		[["memo", "--feat", KB_FEAT, "Elves"], /--feat and --title go with crud dive/],
		[["dive", "--feat", KB_FEAT, "--root", "nope", "Lost"], /crud takes no --root/],
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
	// The linked dive must exist: crud refuses a link to a missing doc.
	write(
		join(bridge, "kb", `${DIVE}.md`),
		`---\nkind: dive\nid: ${DIVE}\nname: mtg\ngist: "Mtg"\n---\n`,
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

test("crud --links refuses a link to a doc that does not exist, but removes one and passes URLs", () => {
	const bridge = createBridge(tmp, "dead-links");
	const id = SPARE;
	const path = join(bridge, "kb", `${id}.md`);
	write(
		join(bridge, "kb", `${CARDS_REPO}.md`),
		`---\nkind: memo\nid: ${CARDS_REPO}\nname: there\ngist: "There"\n---\n`,
	);
	// A dead link written by hand: kb/${DIVE}.md is never made in this bridge.
	write(
		path,
		`---\nkind: memo\nid: ${id}\nname: plan\ngist: "Plan"\nlinks:\n  - kb/${DIVE}.md\n---\n\n# Plan\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "dead link");
	const read = () => readFileSync(path, "utf8");

	for (const [args, input, named] of [
		[[], `${DIVE}: {rel: x.feat}\n`, [DIVE, `kb/${DIVE}.md`]],
		[[], "docs/nowhere.md: {}\n", ["docs/nowhere.md"]],
		[["--replace"], `${CARDS_REPO}: {}\n${DIVE}: {}\n`, [DIVE]],
	]) {
		const before = { text: read(), count: commits(bridge) };
		const refused = run(["crud", id, "--links", "-", ...args], bridge, input);
		assert.equal(refused.status, 1, `${args.join(" ")} ${input}`);
		for (const name of named) assert.ok(refused.stderr.includes(name), refused.stderr);
		assert.equal(read(), before.text, "a refused link writes nothing");
		assert.equal(commits(bridge), before.count, "a refused link commits nothing");
	}

	assertOk(
		run(["crud", id, "--links", "-"], bridge, `${CARDS_REPO}: {rel: x.feat}\n`),
		"linking an existing doc failed",
	);
	assertOk(
		run(["crud", id, "--links", "-"], bridge, "https://example.com/none: {}\n"),
		"linking a URL failed",
	);
	assertOk(
		run(["crud", id, "--links", "-"], bridge, `${DIVE}: null\n`),
		"removing a dead link failed",
	);
	assert.match(
		read(),
		new RegExp(
			`^links:\n {2}- kb/${CARDS_REPO}.md:\n {6}rel: x.feat\n {2}- https://example.com/none\n---`,
			"m",
		),
	);
});
