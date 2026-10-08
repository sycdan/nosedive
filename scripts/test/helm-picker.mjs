import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createBridge,
	createTmp,
	gitCommit,
	implRepo,
	libUrl,
	run,
	runTool,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const { helmConfigNotes, helmDives, helmFeats, helmPicker, helmPickerLoad, helmRepoList } =
	await import(libUrl);
const tmp = createTmp("helm-picker");
const minted = run(["mint", "16"], tmp);
assertOk(minted, "mint failed");
const [
	BACKLOG,
	BRIDGE_REPO,
	R_BACKLOG,
	R_A,
	A,
	B,
	C,
	D,
	E,
	F,
	OTHER,
	PROPS,
	SUB_REPO,
	SUB_BACKLOG,
	WATER,
	GONE_REPO,
] = minted.stdout.trim().split(/\r?\n/);
const DIVE = run(["mint"], tmp).stdout.trim();

function doc(kind, id, name, { scopes = [], links = [], h1 } = {}) {
	return [
		"---",
		`kind: ${kind}`,
		`id: ${id}`,
		`name: ${name}`,
		`gist: "${kind} ${name}"`,
		...(scopes.length ? ["scopes:", ...scopes.map((repo) => `  - ${repo}`)] : []),
		...(links.length
			? [
					"links:",
					...links.flatMap(([to, rel]) => [
						`  - ${to.includes(":") ? to : `kb/${to}.md`}:`,
						`      rel: ${rel}`,
					]),
				]
			: []),
		"---",
		"",
		...(h1 ? [`# ${h1}`, ""] : []),
	].join("\n");
}

/**
 * The backlog reaches alpha, beta and properties; alpha reaches charlie and
 * delta, beta reaches delta again and echo; charlie reaches F, named by its id.
 * Properties links the backlog of homestead, a sub-bridge nobody hydrated, and
 * a doc in a repo whose remote is gone.
 */
const bridge = createBridge(tmp, "bridge", { backlog: BACKLOG, bridge: BRIDGE_REPO });
const kb = join(bridge, "kb");
const homestead = implRepo(tmp, "homestead");
write(
	join(homestead.source, ".nosedive", "config.yaml"),
	`compatibility-level: 2\nkb: ./kb\nbacklog: ${SUB_BACKLOG}\n`,
);
write(
	join(homestead.source, "kb", `${SUB_BACKLOG}.md`),
	doc("memo", SUB_BACKLOG, "bridge", { links: [[WATER, "system.feat"]] }),
);
write(
	join(homestead.source, "kb", `${WATER}.md`),
	doc("feat", WATER, "water-treatment", { h1: "Water treatment" }),
);
runTool("git", ["add", "."], homestead.source);
gitCommit(homestead.source, "sub-bridge");
runTool("git", ["push", "cloud", "main"], homestead.source);
runTool("git", ["push", "local", "main"], homestead.source);
writeImplRepoDoc(bridge, SUB_REPO, homestead);
const subBacklog = `${SUB_REPO}:kb/${SUB_BACKLOG}.md`;
const gone = `${GONE_REPO}:kb/${WATER}.md`;
for (const [id, text] of [
	[BRIDGE_REPO, doc("repo", BRIDGE_REPO, "bridge")],
	[R_BACKLOG, doc("repo", R_BACKLOG, "r-backlog")],
	[R_A, doc("repo", R_A, "r-a")],
	[
		GONE_REPO,
		doc("repo", GONE_REPO, "gone").replace(
			/---\n$/,
			`meta:\n  trunk: main\n  remotes:\n    local: ${join(tmp, "nowhere.git").replaceAll("\\", "/")}\n---\n`,
		),
	],
	[
		BACKLOG,
		doc("memo", BACKLOG, "backlog", {
			scopes: [R_BACKLOG],
			links: [
				[A, "current.feat"],
				[B, "future.feat"],
				[PROPS, "home.feat"],
				[OTHER, "see"],
			],
		}),
	],
	[
		A,
		doc("feat", A, "alpha", {
			scopes: [R_A],
			links: [
				[C, "child.feat"],
				[D, "child.feat"],
			],
		}),
	],
	[
		B,
		doc("feat", B, "beta", {
			links: [
				[BACKLOG, "parent.feat"],
				[D, "child.feat"],
				[E, "child.feat"],
			],
		}),
	],
	[C, doc("feat", C, "charlie", { links: [[F, "child.feat"]] })],
	[D, doc("feat", D, "delta", { links: [[A, "parent.feat"]] })],
	[E, doc("feat", E, "echo")],
	[F, doc("feat", F, F, { h1: "Foxtrot" })],
	[OTHER, doc("memo", OTHER, "other")],
	[
		PROPS,
		doc("memo", PROPS, "properties", {
			scopes: [SUB_REPO, GONE_REPO],
			links: [
				[subBacklog, "property.feat"],
				[gone, "property.feat"],
			],
		}),
	],
])
	write(join(kb, `${id}.md`), text);
runTool("git", ["add", "."], bridge);
gitCommit(bridge, "fixture");

const cache = (repo) => join(bridge, ".nosedive", "cache", repo);
const label = (row) => [...row.path, row.name].join(" › ");

/** Puts a dive on `feat` (none when undefined) for the length of `body`. */
function onDive(feat, body) {
	const divePath = join(kb, `${DIVE}.md`);
	const marker = join(bridge, "workspace", ".nosedive-ref");
	const meta = feat ? `meta:\n  feat: "${feat}"\n` : "";
	write(divePath, `---\nkind: dive\nid: ${DIVE}\nname: a-dive\ngist: "A dive"\n${meta}---\n`);
	write(marker, `id: ${DIVE}\n`);
	try {
		return body();
	} finally {
		rmSync(marker, { force: true });
		rmSync(divePath, { force: true });
	}
}

test("the picker lists every feat the backlog reaches, once, by path, without a fetch", () => {
	const picker = helmPicker(bridge);
	assert.deepEqual(
		picker.rows.map((row) => [label(row), Boolean(row.container), Boolean(row.load)]),
		[
			["alpha", false, false],
			["alpha › charlie", false, false],
			["alpha › charlie › Foxtrot", false, false],
			["alpha › delta", false, false],
			["beta", false, false],
			["beta › echo", false, false],
			["properties", false, false],
			["properties › gone", false, true],
			["properties › homestead", false, true],
		],
		"sorted by path; delta once, under alpha; no parent link walks back up",
	);
	assert.deepEqual(picker.rows[2].chain, [A, C, F], "a row's chain leads to it from the backlog");
	assert.equal(picker.backlog.ref, BACKLOG);
	assert.equal(picker.backlog.container, true, "the backlog is listed, never picked");
	assert.deepEqual(picker.defaultChain, [A], "the default deck: the first feat the backlog links");
	assert.equal(picker.locked, undefined);
	const unread = picker.rows.find((row) => row.ref === subBacklog);
	assert.deepEqual(unread.chain, [PROPS, subBacklog]);
	assert.equal(unread.title, undefined, "Load stands in for its title");
	assert.ok(!existsSync(cache(SUB_REPO)), "nothing was cloned or fetched");
	assert.ok(!existsSync(cache(GONE_REPO)));
});

test("Load reads a sub-bridge's backlog through crud's read: a container, its feats under it", () => {
	const rows = helmPickerLoad(bridge, [PROPS, subBacklog]).rows;
	assert.deepEqual(
		rows.map((row) => [row.ref, label(row), row.title, Boolean(row.container)]),
		[
			[subBacklog, "properties › homestead", undefined, true],
			[
				`${SUB_REPO}:kb/${WATER}.md`,
				"properties › homestead › water-treatment",
				"Water treatment",
				false,
			],
		],
		"a sub-bridge's backlog goes by its repo's name",
	);
	assert.deepEqual(rows[1].chain, [PROPS, subBacklog, `${SUB_REPO}:kb/${WATER}.md`]);
	assert.equal(rows[1].repoName, "homestead");
	assert.ok(existsSync(cache(SUB_REPO)), "Load cloned the managed cache");
	assert.ok(!existsSync(join(bridge, "workspace", "homestead")), "nothing is hydrated");

	assert.throws(
		() => helmPickerLoad(bridge, [PROPS, gone]),
		(err) => err.status === 422 && /nowhere\.git/.test(err.message),
		"an unreachable remote is refused in one line",
	);
	assert.throws(() => helmPickerLoad(bridge, [B, A]), /cannot read .* from beta/, "a broken chain");
});

test("on a dive the deck locks to the dive's feat; with none, to the default", () => {
	const locked = (feat) => onDive(feat, () => helmPicker(bridge).locked);
	assert.deepEqual((({ ref, chain }) => ({ ref, chain }))(locked(F)), { ref: F, chain: [A, C, F] });
	assert.equal(locked(D).ref, D, "the feat itself, not an ancestor");
	assert.equal(locked(undefined).ref, A);
	helmPickerLoad(bridge, [PROPS, subBacklog]);
	const water = locked(`${SUB_REPO}:kb/${WATER}.md`);
	assert.equal(water.ref, `${SUB_REPO}:kb/${WATER}.md`, "a feat in another repo");
	assert.equal(water.title, "Water treatment");
	assert.equal(water.chain, undefined, "not listed until loaded");
});

test("the dives on deck are the deck feat's and those of every feat below it", () => {
	const dives = (root, term) =>
		onDive(F, () => helmDives(bridge, term, root).dives.map((dive) => dive.id));
	assert.deepEqual(dives(A), [DIVE], "F sits under alpha, through charlie");
	assert.deepEqual(dives(F), [DIVE]);
	assert.deepEqual(dives(B), [], "not under beta");
	assert.deepEqual(dives(A, "a-dive"), [DIVE]);
	assert.deepEqual(dives(A, "nothing-like-it"), []);
	helmPickerLoad(bridge, [PROPS, subBacklog]);
	const water = `${SUB_REPO}:kb/${WATER}.md`;
	assert.deepEqual(
		onDive(water, () => helmDives(bridge, undefined, subBacklog).dives.map((dive) => dive.id)),
		[DIVE],
		"a deck in another repo has the bridge's dives on its feats",
	);
});

test("a deck's .feat children, and the repos it scopes, inherited", () => {
	assert.deepEqual(
		helmFeats(bridge, A).map((feat) => [feat.id, feat.rel, feat.hasFeats]),
		[
			[C, "child.feat", true],
			[D, "child.feat", false],
		],
	);
	assert.deepEqual(
		helmFeats(bridge, B).map((feat) => feat.id),
		[D, E],
		"the parent link back to the backlog is not a child",
	);
	const repos = (ref) => helmRepoList(bridge, ref).map((repo) => repo.id);
	assert.deepEqual(repos(A), [R_A, R_BACKLOG], "its own and the backlog's");
	assert.deepEqual(repos(B), [R_BACKLOG], "none of its own: its parent's");
	assert.deepEqual(repos(undefined), [R_BACKLOG], "the backlog's when none is named");
});

test("picker-level is retired: helm ignores the key and notes it", (t) => {
	const configPath = join(bridge, ".nosedive", "config.yaml");
	const before = readFileSync(configPath, "utf8");
	t.after(() => write(configPath, before));
	assert.deepEqual(helmConfigNotes(bridge), []);
	for (const value of ["2", "nonsense"]) {
		write(configPath, `${before}picker-level: ${value}\n`);
		assert.deepEqual(
			helmPicker(bridge).defaultChain,
			[A],
			`picker-level: ${value} changes nothing`,
		);
		assert.match(helmConfigNotes(bridge).join("\n"), /picker-level in .* is retired and ignored/);
	}
});
