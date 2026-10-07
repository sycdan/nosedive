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
	assert.match(seed.stdout, /^Next steps:/m, "seed should include a next-steps heading");
	for (const step of [
		/nosedive preflight -- what needs attention now/,
		/nosedive helm -- see the bridge, and jump its kb feat/,
		/nosedive help -- what else nosedive can do/,
	]) {
		assert.match(seed.stdout, step, "seed should include each next-step command");
	}
	assert.match(
		seed.stdout,
		/or ask your agent "What's next\?"/,
		"seed should end with a natural-language next step",
	);
	assert.doesNotMatch(
		seed.stdout,
		/nosedive pitch/,
		"seed should not mention pitch as it is deprecated",
	);
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
	const backlogId = "01a101ea-25b0-71f5-92d1-079897a6072f";
	writeConfig(bridgeDir, backlogId);
	const origin = bareRepo(tmp, "existing-repo-doc.git");
	runTool("git", ["remote", "add", "origin", origin], bridgeDir);
	write(
		join(bridgeDir, "kb", `${backlogId}.md`),
		["---", "kind: memo", `id: ${backlogId}`, "name: bridge", 'gist: "Backlog."', "---", ""].join(
			"\n",
		),
	);
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
	// Seed also ships its zerostars; what matters here is that no repo doc was minted.
	assert.deepEqual(
		readdirSync(join(bridgeDir, "kb"))
			.filter((file) => !file.startsWith("00000000-0000-"))
			.sort(),
		[`${backlogId}.md`, "existing-repo.md"],
	);
});

const GIVEN_ID = "01a11663-816a-7104-aa58-cf138eda6d29";
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";

test("seed --repo-id mints the bridge's own repo doc with that id, and everything names it", () => {
	const bridgeDir = newBridge("given-id");
	runTool("git", ["remote", "add", "origin", bareRepo(tmp, "given-id.git")], bridgeDir);
	assertOk(
		run(["seed", "--headless", "--file", "AGENTS.md", "--repo-id", GIVEN_ID], bridgeDir, ""),
		"seed failed",
	);
	const config = readFileSync(join(bridgeDir, ".nosedive", "config.yaml"), "utf8");
	assert.match(config, new RegExp(`^bridge: ${GIVEN_ID}$`, "m"));
	assert.match(readFileSync(join(bridgeDir, "kb", `${GIVEN_ID}.md`), "utf8"), /^kind: repo$/m);
	const backlog = /^backlog: (\S+)$/m.exec(config)[1];
	const scoped = new RegExp(`^  - ${GIVEN_ID}:$`, "m");
	assert.match(readFileSync(join(bridgeDir, "kb", `${backlog}.md`), "utf8"), scoped);
	assert.match(readFileSync(join(bridgeDir, "kb", `${KB_FEAT}.md`), "utf8"), scoped);

	assertOk(
		run(["seed", "--headless", "--repo-id", GIVEN_ID], bridgeDir, ""),
		"a repeat run with the same id is a no-op",
	);
	const other = run(["seed", "--headless", "--repo-id", KB_FEAT], bridgeDir, "");
	assert.notEqual(other.status, 0, "another id is refused");
	assert.match(other.stderr, new RegExp(`own repo doc is already ${GIVEN_ID}`));
});

test("seed --no-agents writes no instruction file", () => {
	const bridgeDir = newBridge("no-agents");
	runTool("git", ["remote", "add", "origin", bareRepo(tmp, "no-agents.git")], bridgeDir);
	assertOk(run(["seed", "--headless", "--no-agents"], bridgeDir, ""), "seed failed");
	assert.ok(existsSync(join(bridgeDir, ".nosedive", "config.yaml")));
	for (const file of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"])
		assert.ok(!existsSync(join(bridgeDir, file)), `${file} was written`);
});
