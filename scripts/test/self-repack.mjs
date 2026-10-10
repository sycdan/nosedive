import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createTmp, gitCommit, run, runTool, seededBridge } from "../test-helpers.mjs";

const tmp = createTmp("self-repack");
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();
const self = (bridge) => join(bridge, "workspace", "__self");
const diveRef = (diveId) => `refs/nosedive/dives/${diveId}`;

/** Jumps a free dive on the kb feat, which scopes the bridge, and returns its path and id. */
function jumpKb(bridge) {
	const jumped = run(["jump", KB_FEAT], bridge);
	assertOk(jumped, "jump failed");
	const divePath = /^jump: recorded (\S+)$/m.exec(jumped.stderr)[1];
	return { divePath, diveId: /([0-9a-f-]{36})\.md$/.exec(divePath)[1] };
}

const kbClean = (bridge) => git(["status", "--porcelain", "--", ".nosedive", "kb"], bridge);

test("dives planned on a dive pack as commits on the dive's ref, jump again onto the live bridge, and land", () => {
	const { bridge, origin } = seededBridge(tmp, "plan-twice", "pilot@nosedive.invalid");
	const { divePath, diveId } = jumpKb(bridge);
	assert.equal(git(["rev-parse", "HEAD"], self(bridge)), git(["rev-parse", "HEAD"], bridge));

	// Each lands in __self as one commit: the dive, and its link on the feat right under the dive's own.
	const planned = ["One", "Two"].map((title) => {
		const made = run(
			["crud", "dive", "--feat", KB_FEAT, "--title", title, title],
			bridge,
			`${title}.\n`,
		);
		assertOk(made, "crud dive on a dive failed");
		assert.deepEqual(
			git(["show", "--name-only", "--format=", "HEAD"], self(bridge)).split("\n").sort(),
			[`kb/${KB_FEAT}.md`, /(kb\/[0-9a-f-]{36}\.md)$/m.exec(made.stdout)[1]].sort(),
		);
		return /([0-9a-f-]{36})\.md$/m.exec(made.stdout)[1];
	});

	assertOk(run(["pack"], bridge), "pack failed");
	assert.ok(git(["ls-remote", origin, diveRef(diveId)], bridge), "the work is on the dive's ref");
	assert.doesNotMatch(
		readFileSync(join(bridge, divePath), "utf8"),
		/rel: patch/,
		"no patches for __self",
	);
	assert.equal(git(["rev-parse", "HEAD"], self(bridge)), git(["rev-parse", "HEAD"], bridge));
	for (const id of planned) assert.ok(!existsSync(join(self(bridge), "kb", `${id}.md`)));

	assertOk(run(["jump", divePath], bridge), "jump after pack failed");
	assert.equal(kbClean(bridge), "", "jump committed its bookkeeping");
	const feat = readFileSync(join(self(bridge), "kb", `${KB_FEAT}.md`), "utf8");
	for (const id of planned) {
		assert.ok(
			existsSync(join(self(bridge), "kb", `${id}.md`)),
			"the planned dive is back in __self",
		);
		assert.match(feat, new RegExp(`${id}\\.md:\\n\\s+rel: planned\\.dive`));
	}
	assert.match(
		feat,
		new RegExp(`${diveId}\\.md:\\n\\s+rel: jumped\\.dive`),
		"on the bridge as jump left it",
	);

	assertOk(run(["land"], bridge), "land failed");
	for (const id of planned)
		assert.ok(existsSync(join(bridge, "kb", `${id}.md`)), "landed in the bridge");
	assert.equal(
		git(["ls-remote", origin, diveRef(diveId)], bridge),
		"",
		"land drops the dive's ref",
	);
	assert.equal(git(["rev-parse", "HEAD"], self(bridge)), git(["rev-parse", "HEAD"], bridge));
});

test("work in __self the live bridge since contradicts stops jump mid-rebase, and pack refuses until it is resolved", () => {
	const { bridge, origin } = seededBridge(tmp, "contradict", "pilot@nosedive.invalid");
	const { divePath, diveId } = jumpKb(bridge);
	const made = run(["crud", "memo", "--name", "shared", "Shared"], bridge);
	const memoId = /Minted \S*?([0-9a-f-]{36})\.md/.exec(made.stdout)[1];
	assertOk(run(["pack"], bridge), "pack failed");

	// The same doc, made on the live bridge too, with other words.
	writeFileSync(join(bridge, "kb", `${memoId}.md`), "---\nkind: memo\n---\n\n# Someone else's\n");
	runTool("git", ["add", "kb"], bridge);
	gitCommit(bridge, "the same doc, made on main");
	runTool("git", ["push"], bridge);

	const jumped = run(["jump", divePath], bridge);
	assert.equal(jumped.status, 1, jumped.stderr);
	assert.match(jumped.stderr, new RegExp(`kb/${memoId}\\.md`));
	assert.match(jumped.stderr, /git rebase --continue/);
	assert.ok(
		git(["ls-remote", origin, diveRef(diveId)], bridge),
		"the work stays on the dive's ref",
	);
	assert.equal(kbClean(bridge), "", "jump's bookkeeping stands");

	const refused = run(["pack"], bridge);
	assert.equal(refused.status, 1, refused.stderr);
	assert.match(refused.stderr, /mid-rebase/);
});

test("uncommitted work in __self survives a pack and comes back uncommitted", () => {
	const { bridge } = seededBridge(tmp, "dirty-self", "pilot@nosedive.invalid");
	const { divePath } = jumpKb(bridge);
	const notes = join(self(bridge), "notes.md");
	writeFileSync(notes, "half a thought\n");
	assertOk(run(["pack"], bridge), "pack failed");
	assert.ok(!existsSync(notes), "pack put __self back on the live bridge");

	assertOk(run(["jump", divePath], bridge), "jump after pack failed");
	assert.equal(readFileSync(notes, "utf8"), "half a thought\n");
	assert.equal(git(["status", "--porcelain", "--", "notes.md"], self(bridge)), "?? notes.md");
	assert.equal(git(["rev-parse", "HEAD"], self(bridge)), git(["rev-parse", "HEAD"], bridge));
});

test("the bridge is published by the bridge push alone, so the next dive follows main after main edits what one landed", () => {
	const { bridge, origin } = seededBridge(tmp, "follow-main", "pilot@nosedive.invalid");
	jumpKb(bridge);
	const made = run(["crud", "memo", "--name", "ideas", "Ideas"], bridge);
	const memoId = /Minted \S*?([0-9a-f-]{36})\.md/.exec(made.stdout)[1];
	const landed = run(["land"], bridge);
	assertOk(landed, "land failed");
	assert.doesNotMatch(landed.stderr, /pushing scope/, "no work branch of its own");
	assert.equal(
		git(["for-each-ref", "--format=%(refname)", "refs/heads"], origin),
		"refs/heads/main",
	);

	const memo = join(bridge, "kb", `${memoId}.md`);
	writeFileSync(memo, `${readFileSync(memo, "utf8")}\nEdited on main.\n`);
	runTool("git", ["add", "kb"], bridge);
	gitCommit(bridge, "edit on main");
	runTool("git", ["push"], bridge);

	const second = run(["jump", KB_FEAT], bridge);
	assertOk(second, "second jump failed");
	assert.match(readFileSync(join(self(bridge), "kb", `${memoId}.md`), "utf8"), /Edited on main\./);
	assert.equal(git(["rev-parse", "HEAD"], self(bridge)), git(["rev-parse", "HEAD"], bridge));
});
