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
