import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("pitch");

function effortDoc(bridge, stdout) {
	const match = /^Pitched (.+)$/m.exec(stdout);
	assert.ok(match, `pitch did not report a written doc:\n${stdout}`);
	return readFileSync(join(bridge, match[1]), "utf8");
}

test("pitch writes an effort doc from a bare gist", () => {
	const bridge = createBridge(tmp, "pitch-bare-bridge");

	const pitched = run(["pitch", "Exercise the L1 pitch contract."], bridge);
	assertOk(pitched, "pitch with only a gist failed");
	const doc = effortDoc(bridge, pitched.stdout);
	assert.match(doc, /^kind: feat$/m);
	assert.match(doc, /^id: [0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/m);
	assert.match(doc, /^gist: "Exercise the L1 pitch contract\."$/m);
	assert.match(doc, /^name: new-effort-\d{4}-\d{2}-\d{2}-\d{6}$/m);
	assert.match(doc, /^# New Effort \d{4} \d{2} \d{2} \d{6}$/m);
	assert.doesNotMatch(doc, /^links:/m);
	assert.doesNotMatch(doc, /## /m, "a fresh pitch should carry no body sections");
});

test("pitch names an effort with --name", () => {
	const bridge = createBridge(tmp, "pitch-named-bridge");

	const pitched = run(["pitch", "Rework auth.", "--name", "auth-refactor"], bridge);
	assertOk(pitched, "named pitch failed");
	const doc = effortDoc(bridge, pitched.stdout);
	assert.match(doc, /^name: auth-refactor$/m);
	assert.match(doc, /^# Auth Refactor$/m);
});

test("pitch nests under a parent and links both ways", () => {
	const bridge = createBridge(tmp, "pitch-parent-bridge");

	const parent = run(["pitch", "Parent effort.", "--name", "auth"], bridge);
	assertOk(parent, "parent pitch failed");
	const parentPath = join(bridge, /^Pitched (.+)$/m.exec(parent.stdout)[1]);
	const parentId = /^id: (\S+)$/m.exec(readFileSync(parentPath, "utf8"))[1];

	const child = run(["pitch", "Child effort.", "--name", "tokens", "--parent", "auth"], bridge);
	assertOk(child, "child pitch failed");
	const childPath = join(bridge, /^Pitched (.+)$/m.exec(child.stdout)[1]);
	const childText = readFileSync(childPath, "utf8");
	const childId = /^id: (\S+)$/m.exec(childText)[1];

	assert.match(childText, /^name: tokens\.auth$/m, "child name should be a leaf-first slug chain");
	assert.match(childText, new RegExp(`- kb/${parentId}\\.md:\\n      rel: parent`));
	assert.match(childText, /^# Tokens$/m, "heading should title only the leaf slug");
	assert.match(
		readFileSync(parentPath, "utf8"),
		new RegExp(`- kb/${childId}\\.md:\\n      rel: child`),
		"parent should link back to the child",
	);

	const byId = run(["pitch", "Second child.", "--name", "scopes", "--parent", parentId], bridge);
	assertOk(byId, "pitch --parent by uuid failed");
	assert.match(
		readFileSync(join(bridge, /^Pitched (.+)$/m.exec(byId.stdout)[1]), "utf8"),
		/^name: scopes\.auth$/m,
	);

	const byPath = run(
		["pitch", "Third child.", "--name", "rotation", "--parent", `kb/${parentId}.md`],
		bridge,
	);
	assertOk(byPath, "pitch --parent by kb path failed");
});

test("pitch rejects bad input", () => {
	const bridge = createBridge(tmp, "pitch-reject-bridge");

	const noGist = run(["pitch"], bridge, "");
	assert.notEqual(noGist.status, 0, "pitch without a gist unexpectedly succeeded");
	assert.match(noGist.stderr, /pitch requires a gist/);

	const blankGist = run(["pitch", "   "], bridge, "");
	assert.notEqual(blankGist.status, 0, "pitch with a blank gist unexpectedly succeeded");
	assert.match(blankGist.stderr, /gist cannot be empty/);

	const badName = run(["pitch", "Bad name.", "--name", "Not A Slug"], bridge, "");
	assert.notEqual(badName.status, 0, "pitch with a non-slug name unexpectedly succeeded");
	assert.match(badName.stderr, /pitch name must be kebab-case: Not A Slug/);

	const unknownOption = run(["pitch", "Gist.", "--bogus"], bridge, "");
	assert.notEqual(unknownOption.status, 0, "pitch with an unknown option unexpectedly succeeded");
	assert.match(unknownOption.stderr, /unknown pitch option: --bogus/);

	const extraArgument = run(["pitch", "Gist.", "extra"], bridge, "");
	assert.notEqual(extraArgument.status, 0, "pitch with a second positional unexpectedly succeeded");
	assert.match(extraArgument.stderr, /unexpected pitch argument: extra/);

	const missingParent = run(["pitch", "Gist.", "--parent", "nope"], bridge, "");
	assert.notEqual(missingParent.status, 0, "pitch under a missing parent unexpectedly succeeded");
	assert.match(missingParent.stderr, /effort not found: nope/);

	assertOk(run(["pitch", "First.", "--name", "taken"], bridge), "first pitch failed");
	const duplicate = run(["pitch", "Second.", "--name", "taken"], bridge, "");
	assert.notEqual(duplicate.status, 0, "duplicate effort name unexpectedly succeeded");
	assert.match(duplicate.stderr, /effort already exists: taken/);
});

test("a pitched effort reaches the backlog memo", () => {
	const bridge = createBridge(tmp, "pitch-backlog-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const pitched = run(["pitch", "Indexed effort.", "--name", "indexed"], bridge);
	assertOk(pitched, "pitch failed");
	const inject = /nosedive update-backlog --inject (\S+)$/m.exec(pitched.stdout);
	assert.ok(inject, `pitch did not name the inject command:\n${pitched.stdout}`);

	assertOk(run(["update-backlog", "--inject", inject[1]], bridge), "update-backlog failed");
	const dumped = run(["dump-backlog"], bridge);
	assertOk(dumped, "dump-backlog failed");
	assert.match(dumped.stdout, /Indexed effort\./);
});

test("update-backlog rewrites the memo's scopes from its efforts", () => {
	const bridge = createBridge(tmp, "pitch-backlog-scopes-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const backlogId = /^backlog: (.+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const backlogPath = join(bridge, "kb", `${backlogId}.md`);
	const zebraRepo = "019fc623-0000-7000-8000-0000000000a1";
	const appleRepo = "019fc623-0000-7000-8000-0000000000a2";
	const staleRepo = "019fc623-0000-7000-8000-0000000000a3";
	for (const [id, name] of [
		[zebraRepo, "zebra"],
		[appleRepo, "apple"],
	]) {
		write(
			join(bridge, "kb", `${id}.md`),
			`---\nkind: repo\nid: ${id}\nname: ${name}\ngist: "Test repo"\n---\n`,
		);
	}
	write(
		join(bridge, "kb", "019fc623-0000-7000-8000-0000000000b1.md"),
		`---\nkind: feat\nid: 019fc623-0000-7000-8000-0000000000b1\nname: scoped\ngist: "Scoped effort"\nscopes:\n  - ${zebraRepo}\n  - ${appleRepo}\n---\n\n# Scoped\n`,
	);
	// A scope the efforts no longer justify is replaced, not merged.
	write(
		backlogPath,
		readFileSync(backlogPath, "utf8").replace(
			/^kind: memo$/m,
			`kind: memo\nscopes:\n  - ${staleRepo}`,
		),
	);

	assertOk(
		run(["update-backlog", "--inject", "019fc623-0000-7000-8000-0000000000b1"], bridge),
		"update-backlog failed",
	);
	const memo = readFileSync(backlogPath, "utf8");
	// Sorted by repo doc name, not by uuid.
	assert.match(memo, new RegExp(`^scopes:\n  - ${appleRepo}\n  - ${zebraRepo}$`, "m"));
	assert.doesNotMatch(memo, new RegExp(staleRepo));
});

test("update-backlog leaves scopes alone when the rendered tree scopes no repo", () => {
	const bridge = createBridge(tmp, "pitch-backlog-noscopes-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const backlogId = /^backlog: (.+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const backlogPath = join(bridge, "kb", `${backlogId}.md`);
	const heldRepo = "019fc623-0000-7000-8000-0000000000c1";
	// An empty derivation is no information, not a verdict: it must not clear
	// what the pilot wrote.
	write(
		backlogPath,
		readFileSync(backlogPath, "utf8").replace(
			/^kind: memo$/m,
			`kind: memo\nscopes:\n  - ${heldRepo}`,
		),
	);

	const pitched = run(["pitch", "Unscoped effort."], bridge);
	assertOk(pitched, "pitch failed");
	const inject = /nosedive update-backlog --inject (\S+)$/m.exec(pitched.stdout);
	assert.ok(inject, `pitch did not name the inject command:\n${pitched.stdout}`);
	assertOk(run(["update-backlog", "--inject", inject[1]], bridge), "update-backlog failed");

	const memo = readFileSync(backlogPath, "utf8");
	assert.match(memo, new RegExp(`^scopes:\n  - ${heldRepo}$`, "m"));
	assert.match(memo, /Unscoped effort\./);
});
