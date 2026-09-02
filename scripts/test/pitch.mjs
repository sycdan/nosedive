import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("pitch");

function featDoc(bridge, stdout) {
	const match = /^Recorded (.+)$/m.exec(stdout);
	assert.ok(match, `record.feat did not report a written doc:\n${stdout}`);
	return readFileSync(join(bridge, match[1]), "utf8");
}

test("record.feat writes a feat doc from a bare gist", () => {
	const bridge = createBridge(tmp, "pitch-bare-bridge");

	const pitched = run(["record.feat", "Exercise the record.feat contract."], bridge);
	assertOk(pitched, "record.feat with only a gist failed");
	const doc = featDoc(bridge, pitched.stdout);
	assert.match(doc, /^kind: feat$/m);
	assert.match(doc, /^id: [0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/m);
	assert.match(doc, /^gist: "Exercise the record\.feat contract\."$/m);
	assert.match(doc, /^name: exercise-the-record-feat-contract$/m);
	assert.match(doc, /^# Exercise The Record Feat Contract$/m);
	assert.doesNotMatch(doc, /^links:/m);
	assert.doesNotMatch(doc, /## /m, "a freshly recorded feat should carry no body sections");
});

test("record.feat names a feat with --name", () => {
	const bridge = createBridge(tmp, "pitch-named-bridge");

	const pitched = run(["record.feat", "Rework auth.", "--name", "auth-refactor"], bridge);
	assertOk(pitched, "named record.feat failed");
	const doc = featDoc(bridge, pitched.stdout);
	assert.match(doc, /^name: auth-refactor$/m);
	assert.match(doc, /^# Auth Refactor$/m);
});

test("--name still wins over a gist that would otherwise be derived", () => {
	const bridge = createBridge(tmp, "pitch-name-wins-bridge");

	const pitched = run(
		["record.feat", "This gist would derive a totally different slug.", "--name", "picked-by-hand"],
		bridge,
	);
	assertOk(pitched, "named record.feat over a derivable gist failed");
	const doc = featDoc(bridge, pitched.stdout);
	assert.match(doc, /^name: picked-by-hand$/m);
});

test("record.feat falls back to a timestamp name when the gist yields no usable slug", () => {
	const bridge = createBridge(tmp, "pitch-fallback-bridge");

	const pitched = run(["record.feat", "!!! --- ???"], bridge);
	assertOk(pitched, "record.feat with an unslugable gist failed");
	const doc = featDoc(bridge, pitched.stdout);
	assert.match(doc, /^name: new-feat-\d{4}-\d{2}-\d{2}-\d{6}$/m);
});

test("record.feat nests under a parent and links both ways", () => {
	const bridge = createBridge(tmp, "pitch-parent-bridge");

	const parent = run(["record.feat", "Parent effort.", "--name", "auth"], bridge);
	assertOk(parent, "parent record.feat failed");
	const parentPath = join(bridge, /^Recorded (.+)$/m.exec(parent.stdout)[1]);
	const parentId = /^id: (\S+)$/m.exec(readFileSync(parentPath, "utf8"))[1];

	const child = run(
		["record.feat", "Child effort.", "--name", "tokens", "--parent", "auth"],
		bridge,
	);
	assertOk(child, "child record.feat failed");
	const childPath = join(bridge, /^Recorded (.+)$/m.exec(child.stdout)[1]);
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

	const byId = run(
		["record.feat", "Second child.", "--name", "scopes", "--parent", parentId],
		bridge,
	);
	assertOk(byId, "record.feat --parent by uuid failed");
	assert.match(
		readFileSync(join(bridge, /^Recorded (.+)$/m.exec(byId.stdout)[1]), "utf8"),
		/^name: scopes\.auth$/m,
	);

	const byPath = run(
		["record.feat", "Third child.", "--name", "rotation", "--parent", `kb/${parentId}.md`],
		bridge,
	);
	assertOk(byPath, "record.feat --parent by kb path failed");
});

test("record.feat rejects bad input", () => {
	const bridge = createBridge(tmp, "pitch-reject-bridge");

	const noGist = run(["record.feat"], bridge, "");
	assert.notEqual(noGist.status, 0, "record.feat without a gist unexpectedly succeeded");
	assert.match(noGist.stderr, /record.feat requires --gist/);

	const blankGist = run(["record.feat", "   "], bridge, "");
	assert.notEqual(blankGist.status, 0, "record.feat with a blank gist unexpectedly succeeded");
	assert.match(blankGist.stderr, /gist cannot be empty/);

	const badName = run(["record.feat", "Bad name.", "--name", "Not A Slug"], bridge, "");
	assert.notEqual(badName.status, 0, "record.feat with a non-slug name unexpectedly succeeded");
	assert.match(badName.stderr, /record.feat name must be kebab-case: Not A Slug/);

	const unknownOption = run(["record.feat", "Gist.", "--bogus"], bridge, "");
	assert.notEqual(
		unknownOption.status,
		0,
		"record.feat with an unknown option unexpectedly succeeded",
	);
	assert.match(unknownOption.stderr, /unknown record.feat option: --bogus/);

	const extraArgument = run(["record.feat", "Gist.", "extra"], bridge, "");
	assert.notEqual(
		extraArgument.status,
		0,
		"record.feat with a second positional unexpectedly succeeded",
	);
	assert.match(extraArgument.stderr, /record.feat gist given twice: extra/);

	const missingParent = run(["record.feat", "Gist.", "--parent", "nope"], bridge, "");
	assert.notEqual(
		missingParent.status,
		0,
		"record.feat under a missing parent unexpectedly succeeded",
	);
	assert.match(missingParent.stderr, /feat not found: nope/);

	assertOk(run(["record.feat", "First.", "--name", "taken"], bridge), "first record.feat failed");
	const duplicate = run(["record.feat", "Second.", "--name", "taken"], bridge, "");
	assert.notEqual(duplicate.status, 0, "duplicate feat name unexpectedly succeeded");
	assert.match(duplicate.stderr, /feat already exists: taken/);
});

test("a recorded feat reaches the backlog memo", () => {
	const bridge = createBridge(tmp, "pitch-backlog-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const pitched = run(["record.feat", "Indexed effort.", "--name", "indexed"], bridge);
	assertOk(pitched, "record.feat failed");
	assert.match(pitched.stdout, /^Updated backlog memo: /m, "record.feat should link it itself");

	const dumped = run(["dump-backlog"], bridge);
	assertOk(dumped, "dump-backlog failed");
	assert.match(dumped.stdout, /Indexed effort\./);
});

test("an unparented record.feat links the backlog memo in the same run, with no second command", () => {
	const bridge = createBridge(tmp, "pitch-backlog-self-link-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const backlogId = /^backlog: (.+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const backlogPath = join(bridge, "kb", `${backlogId}.md`);

	const pitched = run(["record.feat", "Self-linked effort.", "--name", "self-linked"], bridge);
	assertOk(pitched, "record.feat failed");
	const doc = featDoc(bridge, pitched.stdout);
	const id = /^id: (\S+)$/m.exec(doc)[1];

	const memo = readFileSync(backlogPath, "utf8");
	assert.match(
		memo,
		new RegExp(`- kb/${id}\\.md:\\n\\s+rel: injected\\.feat`),
		"the backlog memo should already link the new feat, with no update-backlog run",
	);
});

test("a --parent record.feat is reachable only through its parent, not also injected", () => {
	const bridge = createBridge(tmp, "pitch-backlog-parented-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const backlogId = /^backlog: (.+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const backlogPath = join(bridge, "kb", `${backlogId}.md`);

	const parent = run(["record.feat", "Parent effort.", "--name", "parented"], bridge);
	assertOk(parent, "parent record.feat failed");
	const parentId = /^id: (\S+)$/m.exec(featDoc(bridge, parent.stdout))[1];

	const child = run(
		["record.feat", "Child effort.", "--name", "child-of-parented", "--parent", "parented"],
		bridge,
	);
	assertOk(child, "child record.feat failed");
	const childId = /^id: (\S+)$/m.exec(featDoc(bridge, child.stdout))[1];
	assert.doesNotMatch(
		child.stdout,
		/^Updated backlog memo: /m,
		"a --parent record.feat must not also touch the backlog memo",
	);

	const memo = readFileSync(backlogPath, "utf8");
	assert.doesNotMatch(
		memo,
		new RegExp(`- kb/${childId}\\.md:`),
		"the child must not be linked directly from the backlog memo",
	);
	assert.match(memo, new RegExp(`- kb/${parentId}\\.md:`), "the parent should still be linked");
});

test("update-backlog rewrites the memo's scopes from its feats", () => {
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
	// record.feat can no longer mint the unscoped feat this test needs -- with a
	// second repo registered it demands --scope -- so the feat is written by hand,
	// standing in for one recorded before that rule existed.
	const featId = "019fc623-0000-7000-8000-0000000000c3";
	write(
		join(bridge, "kb", `${featId}.md`),
		`---\nkind: feat\nid: ${featId}\nname: unscoped\ngist: "Legacy unscoped effort"\n---\n\n# Unscoped\n`,
	);
	// A second registered repo is what keeps that feat unreachable by derivation:
	// with one repo in the bridge the derivation would pick it and no longer be
	// empty, which is the case this test exists to cover.
	write(
		join(bridge, "kb", "019fc623-0000-7000-8000-0000000000c2.md"),
		`---\nkind: repo\nid: 019fc623-0000-7000-8000-0000000000c2\nname: second\ngist: "Test repo"\n---\n`,
	);
	// An empty derivation is no information, not a verdict: it must not clear
	// what the pilot wrote.
	write(
		backlogPath,
		readFileSync(backlogPath, "utf8").replace(
			/^kind: memo$/m,
			`kind: memo\nscopes:\n  - ${heldRepo}`,
		),
	);
	const updated = run(["update-backlog", "--inject", featId], bridge);
	assertOk(updated, "update-backlog failed");

	const memo = readFileSync(backlogPath, "utf8");
	assert.match(memo, new RegExp(`^scopes:\n  - ${heldRepo}$`, "m"));
	assert.match(memo, /Legacy unscoped effort/);
});

/**
 * A feat that scopes nothing hands every gate declared on it an empty repo set,
 * so the gate cannot pass under `test`. Where the bridge registers exactly one
 * repo, that set has only one candidate, and the generated work branch is what
 * makes it writable.
 */
test("an unparented record.feat scopes the sole registered repo, on the generated work branch", () => {
	const bridge = createBridge(tmp, "pitch-sole-repo-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const repoId = /^bridge: (.+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const repoName = /^name: (.+)$/m.exec(
		readFileSync(join(bridge, "kb", `${repoId}.md`), "utf8"),
	)[1];

	const pitched = run(["record.feat", "Add a hello note."], bridge);
	assertOk(pitched, "record.feat failed");
	assert.match(
		featDoc(bridge, pitched.stdout),
		new RegExp(`^scopes:\n  - ${repoId}:\n      work-branch: work/add-a-hello-note$`, "m"),
		"the sole repo should be scoped on record.dive's generated default branch",
	);
	assert.ok(
		pitched.stdout
			.split("\n")
			.includes(`Scoped feat to the only registered repo: ${repoName} (${repoId})`),
		`record.feat must say it chose a scope rather than doing it silently:\n${pitched.stdout}`,
	);
	// The flags name decisions record.feat have already been taken; typing them again would
	// re-open questions that are closed.
	assert.doesNotMatch(pitched.stdout, /--upscope/);
	assert.doesNotMatch(pitched.stdout, /--work-branch/);
});

test("a record.feat with several registered repos requires an explicit --scope", () => {
	const bridge = createBridge(tmp, "pitch-many-repos-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	write(
		join(bridge, "kb", "019fc623-0000-7000-8000-0000000000d1.md"),
		`---\nkind: repo\nid: 019fc623-0000-7000-8000-0000000000d1\nname: other\ngist: "Test repo"\n---\n`,
	);

	const withoutScope = run(["record.feat", "Touch two repos."], bridge, "");
	assert.notEqual(
		withoutScope.status,
		0,
		"record.feat without a multi-repo scope unexpectedly succeeded",
	);
	assert.match(withoutScope.stderr, /record.feat requires --scope <repo-ref>/);

	const scoped = run(["record.feat", "Touch two repos.", "--scope", "other"], bridge);
	assertOk(scoped, "record.feat with an explicit scope failed");
	assert.match(
		featDoc(bridge, scoped.stdout),
		/^scopes:\n  - 019fc623-0000-7000-8000-0000000000d1:\n      work-branch: work\/touch-two-repos$/m,
	);
	assert.match(scoped.stdout, /^Scoped feat to repo: other /m);
});

test("an explicit --scope replaces the sole-repo default instead of colliding with it", () => {
	const bridge = createBridge(tmp, "pitch-sole-explicit-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	// A pilot who always types --scope must not be punished on a one-repo bridge:
	// the derived default is what --scope replaces, not something it duplicates.
	const scoped = run(
		["record.feat", "--gist", "Touch the one repo.", "--scope", "pitch-sole-explicit-bridge"],
		bridge,
	);
	assertOk(scoped, "record.feat --scope on a one-repo bridge failed");
	const doc = featDoc(bridge, scoped.stdout);
	assert.match(doc, /^scopes:$/m);
	assert.equal(
		(doc.match(/^ {2}- [0-9a-f-]{36}:$/gm) ?? []).length,
		1,
		`expected exactly one scope entry:\n${doc}`,
	);
	assert.match(scoped.stdout, /^Scoped feat to repo: pitch-sole-explicit-bridge /m);
	assert.doesNotMatch(scoped.stdout, /only registered repo/);
	assert.doesNotMatch(scoped.stdout, /--upscope/);
});

test("record.feat resolves every --scope before it writes anything", () => {
	const bridge = createBridge(tmp, "pitch-bad-scope-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	write(
		join(bridge, "kb", "019fc623-0000-7000-8000-0000000000e1.md"),
		`---\nkind: repo\nid: 019fc623-0000-7000-8000-0000000000e1\nname: other\ngist: "Test repo"\n---\n`,
	);
	const before = readdirSync(join(bridge, "kb")).length;

	// A misspelled repo used to fail after the doc was on disk, leaving a feat
	// nobody recorded, uncommitted and unreachable from the backlog.
	const bad = run(["record.feat", "--gist", "Touch two.", "--scope", "nope"], bridge, "");
	assert.notEqual(bad.status, 0, "record.feat with an unknown --scope unexpectedly succeeded");
	assert.match(bad.stderr, /repo not found: nope/);
	assert.doesNotMatch(bad.stdout, /^Recorded /m);
	assert.equal(
		readdirSync(join(bridge, "kb")).length,
		before,
		"a failed record.feat left a doc behind",
	);

	const twice = run(
		["record.feat", "--gist", "Touch two.", "--scope", "other", "--scope", "other"],
		bridge,
		"",
	);
	assert.notEqual(twice.status, 0, "a repeated --scope unexpectedly succeeded");
	assert.match(twice.stderr, /--scope names other twice/);
	assert.equal(
		readdirSync(join(bridge, "kb")).length,
		before,
		"a failed record.feat left a doc behind",
	);
});

test("a --parent record.feat writes no scopes, because it inherits its parent's", () => {
	const bridge = createBridge(tmp, "pitch-parented-scopes-bridge");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	assertOk(
		run(["record.feat", "Parent effort.", "--name", "roots"], bridge),
		"parent record.feat failed",
	);

	const child = run(
		["record.feat", "Child effort.", "--name", "shoots", "--parent", "roots"],
		bridge,
	);
	assertOk(child, "child record.feat failed");
	assert.doesNotMatch(featDoc(bridge, child.stdout), /^scopes:/m);
	assert.doesNotMatch(child.stdout, /^Scoped feat to /m);
});

/**
 * The old spelling is deprecated, not deleted: its doc stays so nothing pinned
 * to it breaks, and the only way to know it still works is to run it.
 */
test("the deprecated pitch spelling still records a feat", () => {
	const bridge = createBridge(tmp, "pitch-deprecated-spelling-bridge");

	const pitched = run(["pitch", "Recorded by the old spelling.", "--name", "old-spelling"], bridge);
	assertOk(pitched, "the deprecated pitch spelling failed");
	const doc = featDoc(bridge, pitched.stdout);
	assert.match(doc, /^kind: feat$/m);
	assert.match(doc, /^name: old-spelling$/m);
});

test("record.feat commits the doc it wrote and leaves unrelated staged work alone", () => {
	const bridge = createBridge(tmp, "pitch-commit-bridge");
	write(join(bridge, "unrelated.md"), "mine\n");
	runTool("git", ["add", "--", "unrelated.md"], bridge);

	const result = run(["record.feat", "Add a hello note"], bridge);
	assertOk(result, "record.feat failed");
	assert.ok(result.stdout.includes("Committed feat(add-a-hello-note): created"), result.stdout);

	// Nothing else ever commits a feat doc: jump and land stage their own paths
	// and stash the rest, so an uncommitted feat reaches no other checkout.
	const committed = runTool("git", ["show", "--pretty=format:", "--name-only", "HEAD"], bridge);
	const files = committed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	assert.ok(
		files.some((file) => file.startsWith("kb/")),
		`the feat doc should be in the commit: ${committed.stdout}`,
	);
	// A pathspec commit, so the pilot keeps whatever they had staged.
	assert.ok(!files.includes("unrelated.md"), `unrelated work was swept in: ${committed.stdout}`);
	const staged = runTool("git", ["diff", "--cached", "--name-only"], bridge);
	assert.ok(staged.stdout.includes("unrelated.md"), staged.stdout);
});
