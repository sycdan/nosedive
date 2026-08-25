import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("note");

function seedBridge(bridge) {
	assertOk(run(["seed", "--headless"], bridge, ""), "seed failed");
}

function notedDoc(bridge, stdout) {
	const match = /^Noted (.+)$/m.exec(stdout);
	assert.ok(match, `note did not report a written doc:\n${stdout}`);
	const relPath = match[1];
	const path = join(bridge, relPath);
	const text = readFileSync(path, "utf8");
	const id = /^id: (\S+)$/m.exec(text)?.[1];
	assert.ok(id, `note has no id:\n${text}`);
	assert.equal(relPath.replaceAll("\\", "/"), `kb/${id}.md`);
	return { id, path, text };
}

function configValue(bridge, key) {
	return new RegExp(`^${key}: (.+)$`, "m").exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)?.[1];
}

test("note writes a default-scoped memo from a bare gist", () => {
	const bridge = createBridge(tmp, "note-bare-bridge");
	seedBridge(bridge);
	const bridgeRepo = configValue(bridge, "bridge");

	const noted = run(
		["note", "seed", "skips", "the", "push", "when", "it", "wrote", "nothing"],
		bridge,
	);
	assertOk(noted, "bare note failed");
	assert.match(
		noted.stdout,
		new RegExp(`^Scoped note to bridge repo: .+ \\(${bridgeRepo}\\)$`, "m"),
	);
	const doc = notedDoc(bridge, noted.stdout);

	assert.match(doc.text, /^kind: memo$/m);
	assert.match(
		doc.text,
		/^id: [0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/m,
	);
	assert.match(doc.text, /^gist: "seed skips the push when it wrote nothing"$/m);
	assert.match(doc.text, new RegExp(`^name: seed-skips-the-push-when-it-[0-9a-f]{6}$`, "m"));
	// The hex suffix disambiguates the name; it is not part of the heading.
	assert.match(doc.text, /^# Seed Skips The Push When It$/m);
	assert.match(doc.text, new RegExp(`^scopes:\n  - ${bridgeRepo}$`, "m"));
	assert.match(
		readFileSync(join(bridge, "kb", `${bridgeRepo}.md`), "utf8"),
		new RegExp(`- kb/${doc.id}\\.md:\n\\s+rel: memo\\.note`),
	);
});

test("note feat mints a feat doc and prints the backlog injection command", () => {
	const bridge = createBridge(tmp, "note-feat-bridge");
	seedBridge(bridge);

	const noted = run(["note", "feat:", "build", "the", "thing"], bridge);
	assertOk(noted, "feat note failed");
	const doc = notedDoc(bridge, noted.stdout);

	assert.match(doc.text, /^kind: feat$/m);
	assert.match(noted.stdout, /^Next steps:$/m);
	assert.match(noted.stdout, new RegExp(`^nosedive update-backlog --inject ${doc.id}$`, "m"));
});

test("note records explicit scopes and body from stdin", () => {
	const bridge = createBridge(tmp, "note-scoped-bridge");
	seedBridge(bridge);
	const repoA = "01a02f1a-7a59-74c0-888b-8d1be760c67c";
	const repoB = "01a02f1a-7a5a-7aa1-bb09-b46667e8f8fd";
	write(
		join(bridge, "kb", `${repoA}.md`),
		`---\nkind: repo\nid: ${repoA}\nname: apple\ngist: "Apple repo"\n---\n`,
	);
	write(
		join(bridge, "kb", `${repoB}.md`),
		`---\nkind: repo\nid: ${repoB}\nname: zebra\ngist: "Zebra repo"\n---\n`,
	);

	const noted = run(
		[
			"note",
			"bug:",
			"explicit",
			"scope",
			"body",
			"--scope",
			"apple",
			"--scope",
			"zebra",
			"--body",
			"-",
		],
		bridge,
		"## Details\n\nBody text.\n",
	);
	assertOk(noted, "scoped note failed");
	assert.doesNotMatch(noted.stdout, /^Scoped note to bridge repo:/m);
	const doc = notedDoc(bridge, noted.stdout);

	assert.match(doc.text, /^kind: bug$/m);
	assert.match(doc.text, new RegExp(`^scopes:\n  - ${repoA}\n  - ${repoB}$`, "m"));
	assert.match(doc.text, /# Explicit Scope Body\n\n## Details\n\nBody text\.\n$/);
	for (const repoId of [repoA, repoB]) {
		assert.match(
			readFileSync(join(bridge, "kb", `${repoId}.md`), "utf8"),
			new RegExp(`- kb/${doc.id}\\.md:\n\\s+rel: bug\\.note`),
		);
	}
});

test("note without --body leaves only the title in the body", () => {
	const bridge = createBridge(tmp, "note-title-only-bridge");
	seedBridge(bridge);

	const noted = run(["note", "only", "a", "title"], bridge);
	assertOk(noted, "title-only note failed");
	const doc = notedDoc(bridge, noted.stdout);
	const body = doc.text.replace(/^---\n[\s\S]*?\n---\n\n/, "");

	assert.match(body, /^# Only A Title\n$/);
	assert.equal(readdirSync(join(bridge, "kb")).filter((name) => name === `${doc.id}.md`).length, 1);
});

test("--title replaces the derived heading and leaves the name alone", () => {
	const bridge = createBridge(tmp, "note-title-bridge");
	seedBridge(bridge);

	const noted = run(
		[
			"note",
			"record-dive",
			"renames",
			"a",
			"dive",
			"that",
			"did",
			"not",
			"move",
			"--title",
			"record.dive renames a dive that did not move",
		],
		bridge,
	);
	assertOk(noted, "titled note failed");
	const doc = notedDoc(bridge, noted.stdout);

	assert.match(doc.text, /^name: record-dive-renames-a-dive-that-[0-9a-f]{6}$/m);
	assert.match(doc.text, /^# record\.dive renames a dive that did not move$/m);
});

test("note commits the note and the repos it back-linked", () => {
	const bridge = createBridge(tmp, "note-commit-bridge");
	seedBridge(bridge);
	const noted = run(["note", "bug:", "the", "pin", "reads", "trunk"], bridge);
	assertOk(noted, "note failed");
	const { id } = notedDoc(bridge, noted.stdout);
	assert.ok(noted.stdout.includes("Committed note(the-pin-reads-trunk-"), noted.stdout);

	// The back-link is half the note: a note nobody can reach from the repo it is
	// about is a note nobody finds, and an uncommitted link reaches no clone.
	const committed = runTool("git", ["show", "--pretty=format:", "--name-only", "HEAD"], bridge);
	const files = committed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	assert.ok(files.includes(`kb/${id}.md`), committed.stdout);
	assert.equal(files.length, 2, `the scoped repo doc should be committed too: ${committed.stdout}`);
});
