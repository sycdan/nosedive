import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";

import { assertOk, createTmp, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("seed-bridge-repo-doc");

function newBridge(name) {
	const bridgeDir = join(tmp, name);
	mkdirSync(bridgeDir, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridgeDir);
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
	runTool("git", ["remote", "add", "origin", "https://example.com/notes.git"], bridgeDir);
	const seed = run(["seed", "--headless", "--file", "AGENTS.md"], bridgeDir, "");
	assertOk(seed, "seed failed");
	const doc = repoDoc(bridgeDir);
	assert.match(doc, /^kind: repo$/m);
	assert.match(doc, new RegExp(`^name: ${basename(bridgeDir)}$`, "m"));
	assert.match(doc, /^  path: "workspace\/__self"$/m);
	assert.match(doc, /^    cloud: "https:\/\/example\.com\/notes\.git"$/m);
	assert.match(seed.stdout, /^nose: /m, "seed should explain the bridge repo guidance");
	assert.match(seed.stdout, /^git add -A$/m, "seed should print the add step");
	assert.match(
		seed.stdout,
		/^git commit -m "seed nosedive"$/m,
		"seed should print the commit step",
	);
	assert.match(seed.stdout, /^git push -u origin main$/m, "seed should print the push step");
	assert.match(
		seed.stdout,
		/^nosedive pitch "<what you want to build>"$/m,
		"seed should end by naming pitch",
	);
});

test("seed does not mint a second bridge repo doc on a repeat run", () => {
	const bridgeDir = newBridge("repeat-origin");
	runTool("git", ["remote", "add", "origin", "https://example.com/notes.git"], bridgeDir);
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
	assert.doesNotMatch(
		secondSeed.stdout,
		/^git add -A$/m,
		"repeat seed should not print the add step",
	);
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

test("seed mints a bridge repo doc without a cloud remote", () => {
	const bridgeDir = newBridge("no-remote");
	const seed = run(["seed", "--headless", "--file", "AGENTS.md"], bridgeDir, "");
	assertOk(seed, "seed failed");
	const doc = repoDoc(bridgeDir);
	assert.match(doc, /^  path: "workspace\/__self"$/m);
	assert.match(doc, /^    local: "\."$/m);
	assert.match(doc, /^  trunk: "main"$/m);
	assert.doesNotMatch(doc, /^    cloud:/m);
	assert.doesNotMatch(doc, /^  url:/m);
	assert.match(seed.stdout, /^nose: /m, "seed should explain the bridge repo guidance");
	assert.match(seed.stdout, /^git add -A$/m, "seed should print the add step");
	assert.match(
		seed.stdout,
		/^git commit -m "seed nosedive"$/m,
		"seed should print the commit step",
	);
	assert.match(
		seed.stdout,
		/a remote has to be added and pushed before work can be scoped to the bridge/m,
	);
});

test("seed skips minting when a matching bridge repo doc already exists", () => {
	const bridgeDir = newBridge("existing-repo-doc");
	writeConfig(bridgeDir, "019f52b7-75a0-7965-93a8-e6b08500eb21");
	runTool("git", ["remote", "add", "origin", "https://example.com/notes.git"], bridgeDir);
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
			"    cloud: https://example.com/notes.git",
			"    local: /tmp/existing-repo-doc",
			"---",
			"",
			"# Existing repo",
			"",
		].join("\n"),
	);
	const seed = run(["seed", "--headless", "--file", "AGENTS.md"], bridgeDir, "");
	assertOk(seed, "seed failed");
	assert.deepEqual(readdirSync(join(bridgeDir, "kb")).sort(), ["existing-repo.md"]);
});
