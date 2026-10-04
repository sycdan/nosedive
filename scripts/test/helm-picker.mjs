import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, gitCommit, libUrl, runTool, write } from "../test-helpers.mjs";

const { helmFeats, helmPicker, helmRepoList } = await import(libUrl);
const tmp = createTmp("helm-picker");

const BACKLOG = "01a103d0-dbe0-7a5b-8cd1-c957d6dd5fa9";
const BRIDGE_REPO = "01a103d0-dbe1-7617-841c-56eb466b840f";
const A = "01a103d0-dbe2-75c2-8cc2-8a0919d5b036";
const B = "01a103d0-dbe3-78ec-90cc-01b46d8ad4c1";
const C = "01a103d0-dbe4-7bd0-acaf-2ae51c238b86";
const D = "01a103d0-dbe5-790b-b1d5-ee42d2819ae4";
const E = "01a103d0-dbe6-748c-8b67-f7a70f735099";
const F = "01a103d0-dbe7-7b16-90e7-4af4a4762f4b";
const OTHER = "01a103d0-dbe8-7cbb-aa71-9d8178e02421";
const R_BACKLOG = "01a103d0-dbe9-705a-a24e-e27b82fd7bbc";
const R_A = "01a103d0-dbea-7e2f-acf1-83492afc3749";
const DIVE = "01a103d0-dbeb-77bc-bfac-e990fcaca3b5";

function doc(kind, id, { scopes = [], links = [] } = {}) {
	return [
		"---",
		`kind: ${kind}`,
		`id: ${id}`,
		`name: ${kind}-${id.slice(-4)}`,
		`gist: "${kind} ${id.slice(-4)}"`,
		...(scopes.length ? ["scopes:", ...scopes.map((repo) => `  - ${repo}`)] : []),
		...(links.length
			? ["links:", ...links.flatMap(([to, rel]) => [`  - kb/${to}.md:`, `      rel: ${rel}`])]
			: []),
		"---",
		"",
	].join("\n");
}

/**
 * The backlog reaches A and B; A reaches C and D, B reaches D again and E;
 * C reaches F. B and D scope nothing, and inherit through their parent link.
 */
const bridge = createBridge(tmp, "bridge", { backlog: BACKLOG, bridge: BRIDGE_REPO });
const kb = join(bridge, "kb");
const configPath = join(bridge, ".nosedive", "config.yaml");
const baseConfig = readFileSync(configPath, "utf8");
for (const [id, text] of [
	[BRIDGE_REPO, doc("repo", BRIDGE_REPO)],
	[R_BACKLOG, doc("repo", R_BACKLOG)],
	[R_A, doc("repo", R_A)],
	[
		BACKLOG,
		doc("memo", BACKLOG, {
			scopes: [R_BACKLOG],
			links: [
				[A, "current.feat"],
				[B, "future.feat"],
				[OTHER, "see"],
			],
		}),
	],
	[
		A,
		doc("feat", A, {
			scopes: [R_A],
			links: [
				[C, "child.feat"],
				[D, "child.feat"],
			],
		}),
	],
	[
		B,
		doc("feat", B, {
			links: [
				[BACKLOG, "parent.feat"],
				[D, "child.feat"],
				[E, "child.feat"],
			],
		}),
	],
	[C, doc("feat", C, { links: [[F, "child.feat"]] })],
	[D, doc("feat", D, { links: [[A, "parent.feat"]] })],
	[E, doc("feat", E)],
	[F, doc("feat", F)],
	[OTHER, doc("memo", OTHER)],
])
	write(join(kb, `${id}.md`), text);
runTool("git", ["add", "."], bridge);
gitCommit(bridge, "fixture");

const level = (n) =>
	write(configPath, n === undefined ? baseConfig : `${baseConfig}picker-level: ${n}\n`);
const ids = (items) => items.map((item) => item.id);

/** Puts a dive on `feat` on deck for the length of `body`. */
function onDive(feat, body) {
	const divePath = join(kb, `${DIVE}.md`);
	const marker = join(bridge, "workspace", ".nosedive-ref");
	write(
		divePath,
		`---\nkind: dive\nid: ${DIVE}\nname: a-dive\ngist: "A dive"\nmeta:\n  feat: ${feat}\n---\n`,
	);
	write(marker, `id: ${DIVE}\n`);
	try {
		body();
	} finally {
		rmSync(marker, { force: true });
		rmSync(divePath, { force: true });
	}
}

test("picker-level 0, the default, offers nothing: the tree is the whole backlog", (t) => {
	t.after(() => level());
	for (const n of [undefined, 0]) {
		level(n);
		const picker = helmPicker(bridge, A);
		assert.equal(picker.level, 0);
		assert.deepEqual(picker.choices, []);
		assert.equal(picker.pick, undefined, "a pick is ignored");
		assert.equal(picker.backlog.id, BACKLOG);
		assert.deepEqual(ids(picker.feats), [A, B]);
		assert.deepEqual(
			helmRepoList(bridge).map((repo) => repo.id),
			[R_BACKLOG],
		);
	}
});

test("picker-level 1 lists what the backlog's .feat links reach; 2 what theirs reach, each once", (t) => {
	t.after(() => level());
	level(1);
	assert.deepEqual(ids(helmPicker(bridge).choices), [A, B]);
	level(2);
	const picker = helmPicker(bridge);
	assert.deepEqual(
		ids(picker.choices),
		[C, D, E],
		"D, reached from A and B, once; no parent link walks back up",
	);
	assert.deepEqual(picker.choices[0], {
		ref: C,
		id: C,
		name: `feat-${C.slice(-4)}`,
		kind: "feat",
		gist: `feat ${C.slice(-4)}`,
		title: undefined,
	});
	assert.equal(picker.pick, undefined, "nothing picked: the whole backlog");
	assert.deepEqual(ids(picker.feats), [A, B]);
	assert.equal(helmPicker(bridge, A).pick, undefined, "a doc not offered at this level is no pick");
});

test("a picked doc heads its .feat children, which expand only into theirs; its repos are inherited", (t) => {
	t.after(() => level());
	level(1);
	const a = helmPicker(bridge, A);
	assert.equal(a.pick, A);
	assert.deepEqual(
		a.feats.map((feat) => [feat.id, feat.rel, feat.hasFeats]),
		[
			[C, "child.feat", true],
			[D, "child.feat", false],
		],
	);
	assert.deepEqual(ids(helmFeats(bridge, C)), [F]);
	assert.deepEqual(
		helmPicker(bridge, B).feats.map((feat) => feat.id),
		[D, E],
		"the parent link back to the backlog is not a child",
	);
	const repos = (ref) => helmRepoList(bridge, ref).map((repo) => repo.id);
	assert.deepEqual(repos(A), [R_A, R_BACKLOG], "its own scopes and the backlog's");
	assert.deepEqual(repos(B), [R_BACKLOG], "none of its own: its parent's");
	assert.deepEqual(repos(D), [R_A, R_BACKLOG]);
});

test("on a dive the pick locks to the offered doc its feat is or is reached from, the first of several", (t) => {
	t.after(() => level());
	const lock = (n, feat) => {
		level(n);
		let picker;
		onDive(feat, () => (picker = helmPicker(bridge, B)));
		assert.equal(picker.locked, true);
		return picker.pick;
	};
	assert.equal(lock(1, F), A, "F sits under A, through C");
	assert.equal(lock(2, F), C);
	assert.equal(lock(2, D), D, "the feat itself, at the level");
	assert.equal(lock(1, D), A, "reached from A and B: the first");
	assert.equal(lock(2, A), undefined, "above the level: the whole backlog");
	assert.equal(lock(1, OTHER), undefined, "out of the tree: the whole backlog");
	assert.equal(lock(0, F), undefined, "level 0 has no picker");
});

test("any picker-level but 0, 1 or 2 is a config error", (t) => {
	t.after(() => level());
	for (const bad of ["3", "-1", "one", "true"]) {
		write(configPath, `${baseConfig}picker-level: ${bad}\n`);
		assert.throws(() => helmPicker(bridge), /picker-level is 0, 1 or 2/, bad);
	}
});
