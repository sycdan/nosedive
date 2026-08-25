import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("record-edit-forms");

/**
 * The edit half of the record family: `record.<thing> <doc> --<field> <value>`.
 *
 * Kept together rather than split across the four per-command files because the
 * point being proved is that the four agree -- one positional meaning the
 * document, one named flag per field, and a bare ref with no fields meaning
 * publish that document as it stands.
 */

function recordedPath(stdout) {
	const match = /^Recorded (.+)$/m.exec(stdout);
	assert.ok(match, `no recorded doc reported:\n${stdout}`);
	return match[1];
}

function idOf(bridge, relPath) {
	return /^id: (\S+)$/m.exec(readFileSync(join(bridge, relPath), "utf8"))[1];
}

function feat(bridge, gist, ...rest) {
	const recorded = run(["record.feat", "--gist", gist, ...rest], bridge);
	assertOk(recorded, `record.feat ${gist} failed`);
	const relPath = recordedPath(recorded.stdout);
	return { relPath, id: idOf(bridge, relPath), stdout: recorded.stdout };
}

function read(bridge, relPath) {
	return readFileSync(join(bridge, relPath), "utf8");
}

test("record.feat patches a gist through the positional and leaves the rest alone", () => {
	const bridge = createBridge(tmp, "feat-gist");
	const parent = feat(bridge, "Original wording.", "--name", "wording");

	const patched = run(["record.feat", parent.relPath, "--gist", "Better wording."], bridge);
	assertOk(patched, "record.feat patch failed");
	const doc = read(bridge, parent.relPath);
	assert.match(doc, /^gist: "Better wording\."$/m);
	assert.match(doc, /^name: wording$/m, "a gist patch should not touch the name");
	assert.ok(patched.stdout.includes("Committed feat(wording): updated"), patched.stdout);
});

test("record.feat renames a feat and everything named after it", () => {
	const bridge = createBridge(tmp, "feat-rename");
	const parent = feat(bridge, "The parent.", "--name", "parent");
	const child = feat(bridge, "The child.", "--name", "child", "--parent", "parent");
	const dive = run(["record.dive", "--feat", "child.parent", "--gist", "Some work."], bridge);
	assertOk(dive, "record.dive failed");
	const divePath = recordedPath(dive.stdout);

	const renamed = run(["record.feat", parent.id, "--name", "ancestor"], bridge);
	assertOk(renamed, "record.feat rename failed");

	assert.match(read(bridge, parent.relPath), /^name: ancestor$/m);
	// The chain is leaf-first, so a descendant carries the renamed feat's slug
	// and has to move with it.
	assert.match(read(bridge, child.relPath), /^name: child\.ancestor$/m);
	assert.match(read(bridge, divePath), /^name: child\.ancestor\.[0-9a-f]{6}$/m);
	// The generated title tracks the leaf; the leaf did not change for the child.
	assert.match(read(bridge, parent.relPath), /^# Ancestor$/m);
});

test("record.feat keeps a hand-written title through a rename", () => {
	const bridge = createBridge(tmp, "feat-title");
	const recorded = feat(bridge, "A feat.", "--name", "before");
	const path = join(bridge, recorded.relPath);
	write(path, readFileSync(path, "utf8").replace(/^# .*$/m, "# Words Somebody Chose"));

	assertOk(run(["record.feat", recorded.id, "--name", "after"], bridge), "rename failed");
	const doc = read(bridge, recorded.relPath);
	assert.match(doc, /^name: after$/m);
	assert.match(doc, /^# Words Somebody Chose$/m, "a title nobody generated is not a slug");
});

test("record.feat re-homes a feat and moves its backlog link with it", () => {
	const bridge = createBridge(tmp, "feat-reparent");
	const parent = feat(bridge, "The parent.", "--name", "parent");
	const orphan = feat(bridge, "On its own.", "--name", "orphan");

	const parented = run(["record.feat", orphan.id, "--parent", "parent"], bridge);
	assertOk(parented, "record.feat --parent failed");
	assert.match(read(bridge, orphan.relPath), /^name: orphan\.parent$/m);
	assert.match(read(bridge, orphan.relPath), new RegExp(`kb/${parent.id}\\.md`));
	assert.match(read(bridge, parent.relPath), new RegExp(`kb/${orphan.id}\\.md`));

	const freed = run(["record.feat", orphan.id, "--no-parent"], bridge);
	assertOk(freed, "record.feat --no-parent failed");
	assert.match(read(bridge, orphan.relPath), /^name: orphan$/m);
	assert.doesNotMatch(read(bridge, orphan.relPath), new RegExp(`kb/${parent.id}\\.md`));
	assert.doesNotMatch(read(bridge, parent.relPath), new RegExp(`kb/${orphan.id}\\.md`));
});

test("record.feat refuses a cycle, and publishes a bare ref rather than refusing it", () => {
	const bridge = createBridge(tmp, "feat-refusals");
	const parent = feat(bridge, "The parent.", "--name", "parent");
	const child = feat(bridge, "The child.", "--name", "child", "--parent", "parent");

	const cycle = run(["record.feat", parent.id, "--parent", child.id], bridge, "");
	assert.notEqual(cycle.status, 0, "parenting an ancestor under its descendant succeeded");
	assert.match(cycle.stderr, /would make a cycle/);

	// A bare ref names no field because it changes none: it means publish this
	// document as it stands. record.feat already committed this one, so there is
	// nothing left to publish and nothing to complain about either.
	const nothing = run(["record.feat", child.id], bridge, "");
	assertOk(nothing, "a bare ref should publish, not refuse");
	assert.match(nothing.stdout, /Already published/);
});

test("a bare record.feat publishes a doc somebody edited by hand", () => {
	const bridge = createBridge(tmp, "feat-bare-publish");
	const recorded = feat(bridge, "A feat.", "--name", "handwritten");
	const path = join(bridge, recorded.relPath);
	write(path, `${readFileSync(path, "utf8")}\nWritten straight into the file.\n`);

	const published = run(["record.feat", recorded.id], bridge, "");
	assertOk(published, "bare record.feat failed");
	assert.match(published.stdout, /Updated /);
	assert.match(
		runTool("git", ["show", `HEAD:kb/${recorded.id}.md`], bridge).stdout,
		/Written straight into the file\./,
	);
	assert.equal(
		runTool("git", ["status", "--porcelain", "--", `kb/${recorded.id}.md`], bridge).stdout,
		"",
	);
});

test("record.gate patches the doc and the link that declares it", () => {
	const bridge = createBridge(tmp, "gate-patch");
	feat(bridge, "Keep it honest.", "--name", "honesty");
	const minted = run(["record.gate", "--gist", "Checks a thing.", "--feat", "honesty"], bridge);
	assertOk(minted, "record.gate failed");
	const gateId = idOf(bridge, recordedPath(minted.stdout));

	const patched = run(
		[
			"record.gate",
			gateId,
			"--gist",
			"Checks a better thing.",
			"--name",
			"the-check",
			"--height",
			"7",
			"--flaky",
			"--action",
			"land",
		],
		bridge,
	);
	assertOk(patched, "record.gate patch failed");
	const doc = read(bridge, `kb/${gateId}.md`);
	assert.match(doc, /^gist: "Checks a better thing\."$/m);
	assert.match(doc, /^name: the-check$/m);
	assert.match(doc, /^# The Check$/m);
	assert.ok(patched.stdout.includes("Committed gate(the-check): updated"), patched.stdout);
});

test("record.gate rewrites its declaration in place rather than adding a second", () => {
	const bridge = createBridge(tmp, "gate-declare");
	const honesty = feat(bridge, "Keep it honest.", "--name", "honesty");
	const minted = run(["record.gate", "--gist", "Checks a thing.", "--feat", "honesty"], bridge);
	assertOk(minted, "record.gate failed");
	const gateId = idOf(bridge, recordedPath(minted.stdout));

	assertOk(run(["record.gate", gateId, "--height", "3"], bridge), "height patch failed");
	assertOk(run(["record.gate", gateId, "--action", "land"], bridge), "action patch failed");
	const featText = read(bridge, honesty.relPath);
	const links = featText.split("\n").filter((line) => line.includes(`kb/${gateId}.md`));
	assert.equal(links.length, 1, `one link, not one per patch:\n${featText}`);
	assert.match(featText, /rel: land\.gate/, featText);
	// The height set by the earlier patch survives a patch that says nothing
	// about it.
	assert.match(featText, /gate-height: 3/, featText);

	const unflaked = run(["record.gate", gateId, "--flaky"], bridge);
	assertOk(unflaked, "flaky patch failed");
	assert.match(read(bridge, honesty.relPath), /test-is-flaky: true/);
	assertOk(run(["record.gate", gateId, "--no-flaky"], bridge), "no-flaky patch failed");
	assert.doesNotMatch(read(bridge, honesty.relPath), /test-is-flaky/);
});

test("record.gate moves a declaration to another feat", () => {
	const bridge = createBridge(tmp, "gate-move");
	const honesty = feat(bridge, "Keep it honest.", "--name", "honesty");
	const elsewhere = feat(bridge, "Somewhere else.", "--name", "elsewhere");
	const minted = run(["record.gate", "--gist", "Checks a thing.", "--feat", "honesty"], bridge);
	assertOk(minted, "record.gate failed");
	const gateId = idOf(bridge, recordedPath(minted.stdout));

	const moved = run(["record.gate", gateId, "--feat", "elsewhere"], bridge);
	assertOk(moved, "record.gate --feat failed");
	assert.doesNotMatch(read(bridge, honesty.relPath), new RegExp(`kb/${gateId}\\.md`));
	assert.match(read(bridge, elsewhere.relPath), new RegExp(`kb/${gateId}\\.md`));
});

test("record.repo patches a registered repository", () => {
	// A seeded bridge, because registering a repository writes the backlog memo.
	const bridge = createBridge(tmp, "repo-patch");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const source = join(tmp, "repo-patch-source");
	runTool("git", ["init", "-b", "main", source], tmp);
	runTool(
		"git",
		["-c", "user.email=t@t.test", "-c", "user.name=T", "commit", "--allow-empty", "-m", "root"],
		source,
	);

	const registered = run(["record.repo", "--url", source, "--name", "widget"], bridge);
	assertOk(registered, "record.repo failed");
	const relPath = recordedPath(registered.stdout);

	const patched = run(
		["record.repo", relPath, "--name", "gadget", "--base-branch", "trunk"],
		bridge,
	);
	assertOk(patched, "record.repo patch failed");
	const doc = read(bridge, relPath);
	assert.match(doc, /^name: gadget$/m);
	assert.match(doc, /^ {2}trunk: "trunk"$/m);
	// The hydrated directory is named by meta.path, and a rename is not a reason
	// to move a checkout out from under the pilot.
	assert.match(doc, /^ {2}path: "workspace\/widget"$/m);
	assert.ok(patched.stdout.includes("Committed repo(gadget): updated"), patched.stdout);
});

test("the retired positional spelling still records, and says so on stderr", () => {
	const bridge = createBridge(tmp, "positional-notice");

	const recorded = run(["record.feat", "Reached the old way."], bridge);
	assertOk(recorded, "the positional gist spelling failed");
	assert.match(recorded.stderr, /positional argument is deprecated/);
	assert.doesNotMatch(recorded.stdout, /deprecated/, "the notice belongs on stderr");
	assert.match(read(bridge, recordedPath(recorded.stdout)), /^gist: "Reached the old way\."$/m);
});
