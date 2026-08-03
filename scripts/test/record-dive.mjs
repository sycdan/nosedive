import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createBridge,
	createTmp,
	gitCommit,
	run,
	runTool,
	write,
} from "../test-helpers.mjs";

const tmp = createTmp("record-dive");
const repoId = "019fc623-0000-7000-8000-000000000001";
const effortId = "019fc623-0000-7000-8000-000000000002";

function setup(name) {
	const bridge = createBridge(tmp, name);
	const repo = join(bridge, "workspace", "repo");
	mkdirSync(repo, { recursive: true });
	runTool("git", ["init", "-b", "main"], repo);
	write(join(repo, "README.md"), "base\n");
	runTool("git", ["add", "."], repo);
	gitCommit(repo, "base");
	write(join(repo, ".nosedive-ref"), `id: ${repoId}\n`);
	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: repo
gist: "Test repo"
meta:
  path: workspace/repo
  trunk: main
---
`,
	);
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: effort
id: ${effortId}
name: record-dive.nosedive
gist: "Record dives"
---

# Record Dive
`,
	);
	return { bridge, repo };
}

function recordedPath(bridge, stdout) {
	const match = /^Recorded (.+)$/m.exec(stdout);
	assert.ok(match, `record.dive did not report a document:\n${stdout}`);
	return join(bridge, match[1]);
}

test("record.dive creates a default record from managed workspace repos", () => {
	const { bridge } = setup("create");
	const result = run(["record.dive", "--effort", effortId], bridge);
	assertOk(result, "record.dive create failed");
	const doc = readFileSync(recordedPath(bridge, result.stdout), "utf8");
	assert.match(doc, /^kind: dive$/m);
	assert.match(doc, /^name: record-dive\.nosedive\.[0-9a-f]{6}$/m);
	assert.match(doc, /^gist: "Working on Record Dive\."$/m);
	assert.match(doc, new RegExp(`^  effort: ${effortId}$`, "m"));
	assert.match(doc, new RegExp(`^  - ${repoId}:\n      ref: [0-9a-f]{40}\n      mode: rw$`, "m"));
	assert.match(doc, /^# Dive Record$/m);
	assert.match(doc, /^id: [0-9a-f-]+$/m);
});

test("record.dive patches only provided fields and can resolve its marker", () => {
	const { bridge } = setup("patch");
	const created = run(
		["record.dive", "--effort", effortId, "--gist", "Initial.", "--brief", "Keep this."],
		bridge,
	);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const marker = join(bridge, "workspace", ".nosedive-ref");
	writeFileSync(marker, `id: ${id}\n`);
	const updated = run(
		["record.dive", "--ref", "workspace/.nosedive-ref", "--title", "Updated"],
		bridge,
	);
	assertOk(updated, "record.dive update failed");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, /^gist: "Initial\."$/m);
	assert.match(doc, /^# Updated$/m);
	assert.match(doc, /## Brief as understood\n\nKeep this\./);
});

test("record.dive validates mutation modes", () => {
	const { bridge } = setup("validation");
	const missingEffort = run(["record.dive"], bridge, "");
	assert.notEqual(missingEffort.status, 0);
	assert.match(missingEffort.stderr, /requires --effort/);
	const conflictingScopes = run(
		["record.dive", "--effort", effortId, "--scope", repoId, "--clear-scopes"],
		bridge,
		"",
	);
	assert.notEqual(conflictingScopes.status, 0);
	assert.match(conflictingScopes.stderr, /cannot be combined/);
	const created = run(["record.dive", "--effort", effortId], bridge);
	assertOk(created, "record.dive create failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	const briefUpdate = run(["record.dive", "--ref", id, "--brief", "Nope"], bridge, "");
	assert.notEqual(briefUpdate.status, 0);
	assert.match(briefUpdate.stderr, /only valid when creating/);
});

test("record.dive activates only for the pilot diver", () => {
	const { bridge } = setup("activation");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const other = run(["record.dive", "--effort", effortId, "--diver", "other@example.test"], bridge);
	assertOk(other, "record.dive with another diver failed");
	assert.equal(existsSync(join(bridge, "workspace", ".nosedive-ref")), false);
	const pilot = run(["record.dive", "--effort", effortId, "--diver", "pilot@example.test"], bridge);
	assertOk(pilot, "record.dive with pilot diver failed");
	assert.match(readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"), /^id: /);
});
