import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	implRepo,
	libUrl,
	run,
	runTool,
	seededBridge,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const { helmCreatableKinds } = await import(libUrl);
const tmp = createTmp("repo-kinds");
const IMPL = "01a0fe82-ca4a-7ad4-9739-e168fe7f3a90";
const FEAT = "01a0fe82-ca4b-7470-85ee-577f0b0702e0";
const NOTE_KIND = "01a0fe82-ca4c-721f-9f61-8d04f5c6d277";

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();
const madeId = (stdout) => /^Minted (?:\S*[\\/])?kb[\\/]([0-9a-f-]{36})\.md$/m.exec(stdout)?.[1];

/**
 * A seeded bridge with a bridge-only `note` kind, and a dive jumped on a feat
 * scoping a repo whose kb is empty; the dive scopes the bridge too.
 */
function onDive(name) {
	const { bridge } = seededBridge(tmp, name, "pilot@nosedive.invalid");
	const impl = implRepo(tmp, `${name}-impl`);
	writeImplRepoDoc(bridge, IMPL, impl);
	write(
		join(bridge, "kb", `${FEAT}.md`),
		`---\nkind: feat\nid: ${FEAT}\nname: impl-work\ngist: "Impl work"\nscopes:\n  - ${IMPL}:\n      work-branch: work/impl\n---\n\n# Impl work\n`,
	);
	write(
		join(bridge, "kb", `${NOTE_KIND}.md`),
		`---\nkind: kind\nid: ${NOTE_KIND}\nname: note\ngist: "The note kind"\nmeta:\n  schema:\n    type: object\n    additionalProperties: false\n    properties: {}\n---\n`,
	);
	// Work is picked up off the deck, so the feat must be on it.
	assertOk(run(["update-backlog", "--inject", FEAT], bridge), "backlog injection failed");
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	runTool("git", ["push"], bridge);
	const recorded = run(["crud", "dive", "--feat", FEAT, "Impl", "work"], bridge, "Work.\n");
	assertOk(recorded, "crud dive failed");
	const divePath = /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1];
	assertOk(run(["jump", divePath], bridge), "jump failed");
	const worktree = join(bridge, "workspace", impl.name);
	return { bridge, impl, worktree, kb: join(worktree, "kb") };
}

test("a repo with an empty kb takes shipped kinds on a dive, and defines its own", () => {
	const { bridge, impl, worktree, kb } = onDive("empty");
	const repo = impl.name;
	assert.ok(!existsSync(join(kb, "00000000-0000-70a0-90bd-1d49dc6264b9.md")));

	// The kind kind is shipped, so the repo can mint its first kind.
	const kind = run(["crud", `${repo}:kind`, "--name", "widget", "A", "widget"], bridge);
	assertOk(kind, "crud <repo>:kind failed");
	const kindId = madeId(kind.stdout);
	assert.match(readFileSync(join(kb, `${kindId}.md`), "utf8"), /^kind: kind$/m);
	assert.equal(git(["log", "-1", "--format=%s"], worktree), `crud(${kindId}): created kind widget`);

	// Its first kind is its own: give it a field, then mint and patch an instance.
	assertOk(
		run(
			["crud", kindId, "--meta", "-"],
			bridge,
			"schema:\n  properties:\n    size:\n      type: number\n",
		),
		"patching the widget schema failed",
	);
	const widget = run(["crud", `${repo}:widget`, "A", "sprocket"], bridge);
	assertOk(widget, "crud <repo>:widget failed");
	const widgetId = madeId(widget.stdout);
	assert.match(readFileSync(join(kb, `${widgetId}.md`), "utf8"), /^kind: widget$/m);
	assertOk(run(["crud", widgetId, "--meta", "-"], bridge, "size: 3\n"), "a valid patch failed");
	const bad = run(["crud", widgetId, "--meta", "-"], bridge, "size: big\n");
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /widget meta would not validate/);

	// A memo is shipped too; it is written, and found again, in the repo.
	const memo = run(["crud", `${repo}:memo`, "A", "repo", "memo"], bridge);
	assertOk(memo, "crud <repo>:memo failed");
	const memoId = madeId(memo.stdout);
	assert.match(readFileSync(join(kb, `${memoId}.md`), "utf8"), /^kind: memo$/m);
	const again = run(["crud", `${repo}:memo`, "A", "repo", "memo"], bridge);
	assertOk(again, "reading the repo memo failed");
	assert.match(again.stdout, new RegExp(`^id: ${memoId}$`, "m"));

	// The dive kind and the bridge's own kinds stay in the bridge.
	const before = git(["rev-list", "--count", "HEAD"], worktree);
	const dive = run(["crud", `${repo}:dive`, "--feat", FEAT, "x"], bridge, "Brief.\n");
	assert.equal(dive.status, 1);
	assert.match(dive.stderr, /a dive lives only in a bridge/);
	const note = run(["crud", `${repo}:note`, "x"], bridge);
	assert.equal(note.status, 1);
	assert.match(note.stderr, /kind note is the bridge's own/);
	assert.match(note.stderr, new RegExp(`crud ${repo}:kind --name note`));
	assert.equal(git(["rev-list", "--count", "HEAD"], worktree), before);

	// Helm offers the repo its own kinds and the shipped ones, but no dive.
	const offered = helmCreatableKinds(bridge)
		.filter((entry) => entry.repoName === repo)
		.map((entry) => `${entry.name}${entry.shipped ? " (shipped)" : ""}`);
	assert.deepEqual(offered, ["kind (shipped)", "memo (shipped)", "widget"]);
	const bridgeOffers = helmCreatableKinds(bridge).filter((entry) => entry.repoName !== repo);
	assert.ok(bridgeOffers.some((entry) => entry.name === "note"));
	assert.ok(bridgeOffers.every((entry) => !entry.shipped && entry.name !== "dive"));
});

test("a repo's own kind wins over a shipped kind of the same name inside it", () => {
	const { bridge, impl, kb } = onDive("own");
	const repo = impl.name;
	const own = run(["crud", `${repo}:kind`, "--name", "memo", "A", "stricter", "memo"], bridge);
	assertOk(own, "defining the repo's memo failed");
	assertOk(
		run(
			["crud", madeId(own.stdout), "--meta", "-"],
			bridge,
			"schema:\n  required: [owner]\n  properties:\n    owner:\n      type: string\n",
		),
		"patching the repo's memo schema failed",
	);

	const refused = run(["crud", `${repo}:memo`, "No", "owner"], bridge);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /cannot be minted with that meta/);
	const made = run(["crud", `${repo}:memo`, "--meta", "-", "Owned"], bridge, "owner: pilot\n");
	assertOk(made, "minting the repo's memo failed");
	assert.match(readFileSync(join(kb, `${madeId(made.stdout)}.md`), "utf8"), /owner: pilot/);

	// The bridge keeps its shipped memo.
	assertOk(run(["crud", "own:memo", "Unowned"], bridge), "the bridge's memo failed");
	const offered = helmCreatableKinds(bridge).filter((entry) => entry.repoName === repo);
	assert.deepEqual(
		offered.map((entry) => `${entry.name}${entry.shipped ? " (shipped)" : ""}`),
		["kind (shipped)", "memo"],
	);
});

test("land refuses a shipped kind change that strands a memo in a repo that takes it", () => {
	const { bridge, impl, kb } = onDive("strand");
	const memo = run(["crud", `${impl.name}:memo`, "A", "repo", "memo"], bridge);
	assertOk(memo, "crud <repo>:memo failed");
	const memoId = madeId(memo.stdout);
	assert.ok(existsSync(join(kb, `${memoId}.md`)));

	assertOk(
		run(
			["crud", "strand:00000000-0000-7bb2-8122-2cad84184e09", "--meta", "-"],
			bridge,
			"schema:\n  required: [owner]\n",
		),
		"tightening the bridge's memo failed",
	);
	const refused = run(["land"], bridge);
	assert.equal(refused.status, 1, refused.stdout);
	assert.match(refused.stderr, /fail its new schema/);
	assert.match(refused.stderr, new RegExp(`${impl.name}: memo ${memoId}`));
});
