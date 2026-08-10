import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	packageVersionPattern,
	run,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("bail");
const effortId = "019fcf20-0000-7000-8000-000000000001";

function bridgeWithDive(label) {
	const origin = join(tmp, `${label}-origin.git`);
	const bridge = join(tmp, label);
	mkdirSync(origin, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], origin);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Bail Test"], bridge);
	runTool("git", ["config", "user.email", "bail@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: bail-test.nosedive
gist: "Bail test effort"
---
`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "initial bridge state");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	const dive = run(["record.dive", "--effort", effortId, "--diver", "bail@example.test"], bridge);
	assertOk(dive, "record.dive failed");
	const diveId = /kb[\\/]([0-9a-f-]{36})\.md/.exec(dive.stdout)?.[1];
	assert.ok(diveId, `could not read dive id from record.dive output: ${dive.stdout}`);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "record dive");
	return { bridge, diveId, divePath: join(bridge, "kb", `${diveId}.md`) };
}

test("bail commits effort and nosedive provenance", () => {
	const { bridge, divePath } = bridgeWithDive("happy");
	const result = run(["bail", "--reason", "testing"], bridge);
	assertOk(result, "bail failed");
	const commitBody = runTool("git", ["log", "-1", "--format=%B"], bridge).stdout;
	assert.match(commitBody, new RegExp(`Effort: ${effortId}`));
	assert.match(commitBody, /bail\(.*\): testing/);
	assert.match(
		commitBody,
		new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern} <noreply@nosedive\\.dev>`),
	);
	assert.equal((commitBody.match(/Co-Authored-By: nosedive/g) ?? []).length, 1);
	const doc = readFileSync(divePath, "utf8");
	assert.match(doc, /kind: memo/);
	assert.match(doc, /-- bailed: testing/);
	assert.equal(existsSync(join(bridge, "workspace", ".nosedive-ref")), false);
});

test("bail without --reason refuses and writes nothing", () => {
	const { bridge, divePath } = bridgeWithDive("no-reason");
	const before = readFileSync(divePath, "utf8");
	const head = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();
	const status = runTool("git", ["status", "--porcelain"], bridge).stdout;

	const result = run(["bail"], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--reason/);
	assert.equal(readFileSync(divePath, "utf8"), before);
	assert.equal(runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(), head);
	assert.equal(runTool("git", ["status", "--porcelain"], bridge).stdout, status);
	assert.equal(existsSync(join(bridge, "workspace", ".nosedive-ref")), true);
});

test("bail rejects a positional reason", () => {
	const { bridge, divePath } = bridgeWithDive("positional");
	const before = readFileSync(divePath, "utf8");

	const result = run(["bail", "some prose"], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /unexpected bail argument.*--reason/s);
	assert.equal(readFileSync(divePath, "utf8"), before);
	assert.equal(existsSync(join(bridge, "workspace", ".nosedive-ref")), true);
});

test("bail refuses an empty --reason", () => {
	const { bridge } = bridgeWithDive("empty");
	const result = run(["bail", "--reason", "   "], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /reason cannot be empty/);
});

test("bail requires --reason on the never-committed path", () => {
	const { bridge, divePath } = bridgeWithDive("uncommitted");
	runTool("git", ["rm", "--cached", "--", `kb/${divePath.split(/[\\/]/).pop()}`], bridge);
	gitCommit(bridge, "untrack dive");

	const refused = run(["bail"], bridge);
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /--reason/);
	assert.equal(existsSync(divePath), true);

	const result = run(["bail", "--reason", "never shared"], bridge);
	assertOk(result, "bail failed");
	assert.equal(existsSync(divePath), false);
});

// --- bail report ---------------------------------------------------------

const scopedRepoId = "019fcf20-0000-7000-8000-000000000002";

function sourceRepo(name) {
	const path = join(tmp, `${name}-source`);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "-b", "main"], path);
	write(join(path, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], path);
	gitCommit(path, "base");
	return path;
}

function bridgeWithScopedDive(label) {
	const origin = join(tmp, `${label}-origin.git`);
	const bridge = join(tmp, label);
	const source = sourceRepo(label);
	mkdirSync(origin, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], origin);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Bail Test"], bridge);
	runTool("git", ["config", "user.email", "bail@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	write(
		join(bridge, "kb", `${scopedRepoId}.md`),
		`---
kind: repo
id: ${scopedRepoId}
name: ${label}-repo
gist: "Bail test scoped repo"
meta:
  path: workspace/${label}-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
---
`,
	);
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: bail-test.nosedive
gist: "Bail test effort"
scopes:
  - ${scopedRepoId}
---

# Bail Test
`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "initial bridge state");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	assertOk(run(["hydrate-repo.workspace", scopedRepoId], bridge), "hydrate scoped repo failed");
	const dive = run(["record.dive", "--effort", effortId, "--diver", "bail@example.test"], bridge);
	assertOk(dive, "record.dive failed");
	const diveId = /kb[\\/]([0-9a-f-]{36})\.md/.exec(dive.stdout)?.[1];
	assert.ok(diveId, `could not read dive id from record.dive output: ${dive.stdout}`);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "record dive");

	const divePath = join(bridge, "kb", `${diveId}.md`);
	const pin = /^\s+ref: ([0-9a-f]{40})$/m.exec(readFileSync(divePath, "utf8"))?.[1];
	assert.ok(pin, "dive should carry a scope pin");
	return { bridge, diveId, divePath, worktree: join(bridge, "workspace", `${label}-repo`), pin };
}

test("bail records every commit above the pin, restorably, in one bridge commit", () => {
	const { bridge, divePath, worktree, pin } = bridgeWithScopedDive("report-ahead");
	write(join(worktree, "a.txt"), "a\n");
	runTool("git", ["add", "a.txt"], worktree);
	gitCommit(worktree, "add feature a");
	write(join(worktree, "b.txt"), "b\n");
	runTool("git", ["add", "b.txt"], worktree);
	gitCommit(worktree, "add feature b");
	const head = runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim();
	const bridgeHeadBefore = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	assertOk(run(["bail", "--reason", "wrong approach entirely"], bridge), "bail failed");

	const doc = readFileSync(divePath, "utf8");
	assert.match(doc, /## Bail report \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
	assert.match(doc, /Bailed\. Reason: wrong approach entirely/);
	assert.match(doc, new RegExp(`pin=${pin} head=${head}`));
	assert.match(doc, /add feature a/);
	assert.match(doc, /add feature b/);
	// oldest first
	assert.ok(doc.indexOf("add feature a") < doc.indexOf("add feature b"));
	assert.doesNotMatch(doc, /uncommitted work is not recoverable/);
	assert.match(doc, /kind: memo/);

	// the report and the frontmatter change are one commit
	const behind = runTool(
		"git",
		["rev-list", "--count", `${bridgeHeadBefore}..HEAD`],
		bridge,
	).stdout.trim();
	assert.equal(behind, "1");

	// the recorded shas still resolve
	for (const sha of [...doc.matchAll(/^ {4}- ([0-9a-f]{7,}) /gm)].map((m) => m[1])) {
		const resolved = runTool("git", ["rev-parse", "--verify", `${sha}^{commit}`], worktree);
		assert.equal(resolved.status, 0, `sha ${sha} no longer resolves`);
	}
});

test("bail records a scope sitting on its pin as holding no commits", () => {
	const { bridge, divePath } = bridgeWithScopedDive("report-clean");
	assertOk(run(["bail", "--reason", "nothing came of it"], bridge), "bail failed");
	const doc = readFileSync(divePath, "utf8");
	assert.match(doc, /held no commits above its pin/);
	assert.doesNotMatch(doc, /uncommitted work is not recoverable/);
});

test("bail records a dirty worktree as having lost its uncommitted work", () => {
	const { bridge, divePath, worktree } = bridgeWithScopedDive("report-dirty");
	write(join(worktree, "README.md"), "base\nedited\n");
	assertOk(run(["bail", "--reason", "scrapping the edit"], bridge), "bail failed");
	const doc = readFileSync(divePath, "utf8");
	assert.match(doc, /worktree was dirty; the uncommitted work is not recoverable/);
	assert.match(doc, /held no commits above its pin/);
});

test("bail reports a missing worktree instead of throwing", () => {
	const { bridge, divePath, worktree } = bridgeWithScopedDive("report-missing");
	assertOk(run(["dehydrate-repo.workspace", scopedRepoId], bridge), "dehydrate scoped repo failed");
	assert.equal(existsSync(worktree), false);

	const result = run(["bail", "--reason", "abandoned cold"], bridge);
	assertOk(result, "bail failed on a missing worktree");
	const doc = readFileSync(divePath, "utf8");
	assert.match(doc, /no worktree on disk; nothing to record/);
});
