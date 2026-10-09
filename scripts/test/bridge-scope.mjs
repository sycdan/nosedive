import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	implRepo,
	run,
	runTool,
	seededBridge,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const tmp = createTmp("bridge-scope");
const IMPL = "01a0fe62-950b-73c8-a998-4d0402f3e9ae";
const FEAT = "01a0fe62-950c-7d56-b26a-4d18730f1793";

/** `[repo, branch]` pairs as a `scopes:` block; an undefined branch names none. */
const scopesYaml = (pairs) =>
	pairs
		.map(([id, branch]) => (branch ? `  - ${id}:\n      work-branch: ${branch}\n` : `  - ${id}\n`))
		.join("");

/**
 * A seeded bridge registering one other repo, a feat scoping `featScopes`, and a
 * backlog scoping `backlogScopes` -- the bridge on `work/kb` unless told -- that
 * links the feat unless `linked` is false.
 */
function setup(name, featScopes, { backlogScopes, linked = true } = {}) {
	const { bridge, origin } = seededBridge(tmp, name, "pilot@nosedive.invalid");
	const config = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const bridgeId = /^bridge: (\S+)$/m.exec(config)[1];
	const backlogPath = join(bridge, "kb", `${/^backlog: (\S+)$/m.exec(config)[1]}.md`);
	const impl = implRepo(tmp, `${name}-impl`);
	writeImplRepoDoc(bridge, IMPL, impl);
	write(
		join(bridge, "kb", `${FEAT}.md`),
		`---\nkind: feat\nid: ${FEAT}\nname: impl-work\ngist: "Impl work"\nscopes:\n${scopesYaml(featScopes({ bridgeId }))}---\n\n# Impl work\n`,
	);
	const rootScopes = (backlogScopes ?? (() => [[bridgeId, "work/kb"]]))({ bridgeId });
	const link = linked ? `  - kb/${FEAT}.md:\n      rel: current.feat\n` : "";
	write(
		backlogPath,
		readFileSync(backlogPath, "utf8")
			.replace(
				/^scopes:\n(?: .*\n)*/m,
				`scopes:${rootScopes.length ? "\n" : " []\n"}${scopesYaml(rootScopes)}`,
			)
			.replace(/^links:\n/m, `links:\n${link}`),
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	return { bridge, bridgeId, origin, impl };
}

const implOnly = () => [[IMPL, "work/impl"]];

function recordDive(bridge, args) {
	const recorded = run(["record.dive", "--feat", FEAT, ...args], bridge);
	assertOk(recorded, "record.dive failed");
	const path = /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1];
	return { text: readFileSync(join(bridge, path), "utf8"), stderr: recorded.stderr };
}

/** The dive's scopes as `repo -> work-branch`, in order. */
function scopesOf(text) {
	const block = /^scopes:\n((?: .*\n)*)/m.exec(text)?.[1] ?? "";
	return [
		...block.matchAll(/^ {2}- (\S+):\n(?: {6}ref: \S+\n)?(?: {6}work-branch: (\S+)\n)?/gm),
	].map(([, repo, branch]) => [repo, branch]);
}

test("a dive takes the backlog's scopes plus its feat's, the feat's entry winning", () => {
	const both = ({ bridgeId }) => [
		[IMPL, "work/impl"],
		[bridgeId, "work/mine"],
	];
	const { bridge, bridgeId } = setup("already", both);
	assert.deepEqual(scopesOf(recordDive(bridge, []).text), [
		[IMPL, "work/impl"],
		[bridgeId, "work/mine"],
	]);
	// With the feat's scopes cleared, the backlog's entry for the bridge answers.
	assert.deepEqual(scopesOf(recordDive(bridge, ["--clear-scopes"]).text), [[bridgeId, "work/kb"]]);
});

test("--clear-scopes keeps the backlog's scopes, and --unscope drops either", () => {
	const { bridge, bridgeId } = setup("clear", implOnly);
	assert.deepEqual(scopesOf(recordDive(bridge, []).text), [
		[IMPL, "work/impl"],
		[bridgeId, "work/kb"],
	]);
	assert.deepEqual(scopesOf(recordDive(bridge, ["--clear-scopes"]).text), [[bridgeId, "work/kb"]]);
	assert.deepEqual(scopesOf(recordDive(bridge, ["--unscope", bridgeId]).text), [
		[IMPL, "work/impl"],
	]);
	assert.deepEqual(scopesOf(recordDive(bridge, ["--unscope", IMPL]).text), [[bridgeId, "work/kb"]]);
});

test("a repo only the backlog names takes the backlog's branch, or none", () => {
	const { bridge, bridgeId } = setup("ro", implOnly, {
		backlogScopes: ({ bridgeId }) => [[bridgeId, undefined]],
	});
	assert.deepEqual(scopesOf(recordDive(bridge, []).text), [
		[IMPL, "work/impl"],
		[bridgeId, undefined],
	]);
});

test("a backlog scoping nothing, or not reaching the feat, gives only the feat's scopes", () => {
	const none = setup("bare-root", implOnly, { backlogScopes: () => [] });
	assert.deepEqual(scopesOf(recordDive(none.bridge, []).text), [[IMPL, "work/impl"]]);
	const unreached = setup("unreached", implOnly, { linked: false });
	assert.deepEqual(scopesOf(recordDive(unreached.bridge, []).text), [[IMPL, "work/impl"]]);
});

test("the no-scopes warning fires only when the dive ends up with none", () => {
	const { bridge, bridgeId } = setup("unscoped", () => []);
	const recorded = recordDive(bridge, []);
	assert.doesNotMatch(recorded.stderr, /scope no repos/);
	assert.deepEqual(scopesOf(recorded.text), [[bridgeId, "work/kb"]]);
	const bare = setup("all-unscoped", () => [], { backlogScopes: () => [] });
	const empty = recordDive(bare.bridge, []);
	assert.match(empty.stderr, /scope no repos/);
	assert.deepEqual(scopesOf(empty.text), []);
});

test("land skips a scope with nothing past its pin, the bridge's own included", () => {
	const { bridge, bridgeId, origin, impl } = setup("untouched", implOnly);
	const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();
	runTool("git", ["push"], bridge);
	const recorded = run(["crud", "dive", "--feat", FEAT, "Change", "impl"], bridge, "Work.\n");
	assertOk(recorded, "crud dive failed");
	const divePath = /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1];
	assertOk(run(["jump", divePath], bridge), "jump failed");

	// Only the impl repo changes; the dive's `__self` checkout of the bridge does not.
	const worktree = join(bridge, "workspace", impl.name);
	write(join(worktree, "CHANGE.md"), "changed\n");
	runTool("git", ["add", "CHANGE.md"], worktree);
	gitCommit(worktree, "change impl");

	const landed = run(["land"], bridge);
	assertOk(landed, "land failed");
	assert.match(landed.stderr, new RegExp(`land: pushed scope ${IMPL} -> work/impl`));
	assert.match(landed.stderr, new RegExp(`land: scope ${bridgeId} unchanged; not pushed`));
	assert.doesNotMatch(landed.stderr, /bringing the bridge's own scope/);
	assert.equal(git(["branch", "--list", "work/kb"], origin), "", "the bridge is not pushed");
	assert.notEqual(git(["branch", "--list", "work/impl"], impl.cloud), "", "the change is");
	const memo = readFileSync(join(bridge, divePath), "utf8");
	assert.match(memo, new RegExp(`^- ${IMPL} -> work/impl$`, "m"));
	assert.match(memo, new RegExp(`^- ${bridgeId} unchanged; not pushed$`, "m"));
});
