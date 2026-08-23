import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";

import { assertOk, bareRepo, createTmp, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("seed-bridge-repo-doc");

function newBridge(name, trunk = "main") {
	const bridgeDir = join(tmp, name);
	mkdirSync(bridgeDir, { recursive: true });
	runTool("git", ["init", "-b", trunk], bridgeDir);
	runTool("git", ["config", "user.name", "Seed Person"], bridgeDir);
	runTool("git", ["config", "user.email", "seed@example.invalid"], bridgeDir);
	return bridgeDir;
}

function writeConfig(bridgeDir, backlogId) {
	const lines = ["compatibility-level: 2", "workspace: ./workspace", "kb: ./kb"];
	if (backlogId) lines.push(`backlog: ${backlogId}`);
	write(join(bridgeDir, ".nosedive", "config.yaml"), `${lines.join("\n")}\n`);
}

function kbDocs(bridgeDir) {
	const kbDir = join(bridgeDir, "kb");
	if (!existsSync(kbDir)) return [];
	return readdirSync(kbDir)
		.filter((entry) => entry.endsWith(".md"))
		.sort()
		.map((entry) => readFileSync(join(kbDir, entry), "utf8"));
}

function repoDoc(bridgeDir) {
	const docs = kbDocs(bridgeDir);
	for (const doc of docs) {
		if (/^kind: repo$/m.test(doc)) return doc;
	}
	assert.fail(`no repo doc found in ${bridgeDir}`);
}

test("seed creates a bridge repo doc from an origin remote", () => {
	const bridgeDir = newBridge("fresh-origin");
	const origin = bareRepo(tmp, "fresh-origin.git");
	runTool("git", ["remote", "add", "origin", origin], bridgeDir);
	const seed = run(["seed", "--headless", "--file", "AGENTS.md"], bridgeDir, "");
	assertOk(seed, "seed failed");
	const doc = repoDoc(bridgeDir);
	assert.match(doc, /^kind: repo$/m);
	assert.match(doc, new RegExp(`^name: ${basename(bridgeDir)}$`, "m"));
	assert.match(doc, /^  path: "workspace\/__self"$/m);
	assert.ok(doc.includes(`    cloud: ${JSON.stringify(origin)}\n`));
	assert.doesNotMatch(seed.stdout, /^git /m, "successful seed should not name a git command");
	assert.match(
		seed.stdout,
		/nosedive preflight -- what needs attention now\nnosedive help -- what else nosedive can do\nor ask your agent "What's next\?"\n$/,
		"seed should end with three next steps",
	);
	assert.doesNotMatch(seed.stdout, /nosedive pitch/);
});

test("seed does not mint a second bridge repo doc on a repeat run", () => {
	const bridgeDir = newBridge("repeat-origin");
	runTool("git", ["remote", "add", "origin", bareRepo(tmp, "repeat-origin.git")], bridgeDir);
	const firstSeed = run(["seed", "--headless", "--file", "AGENTS.md"], bridgeDir, "");
	assertOk(firstSeed, "first seed failed");
	const before = kbDocs(bridgeDir);
	const secondSeed = run(["seed", "--headless", "--file", "AGENTS.md"], bridgeDir, "");
	assertOk(secondSeed, "second seed failed");
	const after = kbDocs(bridgeDir);
	assert.deepEqual(after, before);
	assert.doesNotMatch(
		secondSeed.stdout,
		/^nose: /m,
		"repeat seed should not print bridge repo guidance",
	);
	assert.doesNotMatch(secondSeed.stdout, /^git add /m, "repeat seed should not print the add step");
	assert.doesNotMatch(
		secondSeed.stdout,
		/^git commit -m "seed nosedive"$/m,
		"repeat seed should not print the commit step",
	);
	assert.doesNotMatch(
		secondSeed.stdout,
		/^git push -u origin main$/m,
		"repeat seed should not print the push step",
	);
});

test("seed refuses a bridge with no origin remote", () => {
	const bridgeDir = newBridge("no-remote");
	const seed = run(["seed", "--headless", "--file", "AGENTS.md"], bridgeDir, "");
	assert.notEqual(seed.status, 0, "seed should fail without an origin remote");
	assert.match(seed.stderr, /needs a remote named origin/, "the refusal names what is missing");
	assert.match(seed.stderr, /every scope pin resolves against it/, "the refusal says why");
	assert.match(seed.stderr, /git remote add origin/, "the refusal names the fix");
	// Nothing written. The check runs before the migration, so a pilot who adds
	// the remote and runs again seeds a clean bridge rather than half of one.
	assert.equal(existsSync(join(bridgeDir, ".nosedive", "config.yaml")), false);
	assert.equal(existsSync(join(bridgeDir, "kb")), false);
	assert.equal(existsSync(join(bridgeDir, "AGENTS.md")), false);
});

test("seed skips minting when a matching bridge repo doc already exists", () => {
	const bridgeDir = newBridge("existing-repo-doc");
	// nose: this seems wrong... shared id for backlog memo and repo doc?
	writeConfig(bridgeDir, "019f52b7-75a0-7965-93a8-e6b08500eb21");
	const origin = bareRepo(tmp, "existing-repo-doc.git");
	runTool("git", ["remote", "add", "origin", origin], bridgeDir);
	write(
		join(bridgeDir, "kb", "existing-repo.md"),
		[
			"---",
			"kind: repo",
			"id: 019f52b7-75a0-7965-93a8-e6b08500eb21",
			"name: existing-repo-doc",
			'gist: "Bridge repo existing-repo-doc."',
			"meta:",
			"  path: workspace/__self",
			"  remotes:",
			`    cloud: ${origin.replaceAll("\\", "/")}`,
			"    local: /tmp/existing-repo-doc",
			"---",
			"",
			"# Existing repo",
			"",
		].join("\n"),
	);
	const seed = run(["seed", "--headless"], bridgeDir, "");
	assertOk(seed, "seed failed");
	assert.deepEqual(readdirSync(join(bridgeDir, "kb")).sort(), ["existing-repo.md"]);
});
