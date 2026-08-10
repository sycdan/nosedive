import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, root, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("exec");
const fakeRunner = join(root, "scripts", "test", "fixtures", "fake-runner.mjs");
const runnerId = "019fda60-0000-7000-8000-000000000001";
const backlogId = "019fda60-0000-7000-8000-000000000002";
const posix = (path) => path.replaceAll("\\", "/");

/**
 * `into` is the prompt command under test: its stdout is a brief, which is
 * exactly what `--exec` exists to hand to a runner. The bridge needs a git
 * identity and a backlog memo before `into` will print one.
 */
function createExecBridge(name, models, usage) {
	const bridge = join(tmp, name);
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Exec Test"], bridge);
	runTool("git", ["config", "user.email", "exec@example.test"], bridge);

	const log = join(bridge, "runner.log");
	write(
		join(bridge, ".nosedive", "config.yaml"),
		[
			"compatibility-level: 2",
			"workspace: ./workspace",
			"kb: ./kb",
			`backlog: ${backlogId}`,
			`agent-runner: ${runnerId}`,
			...models.map((model, effort) => `agent-effort-${effort}: ${model}`),
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${backlogId}.md`),
		[
			"---",
			"kind: memo",
			`id: ${backlogId}`,
			"name: backlog.exec-test",
			'gist: "Backlog"',
			"---",
			"",
			"# Backlog",
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${runnerId}.md`),
		[
			"---",
			"kind: memo",
			`id: ${runnerId}`,
			"name: fake.agent-runner",
			'gist: "Fake runner."',
			"meta:",
			`  cold-start-usage: ${JSON.stringify(usage ?? `<nosedive-command-stdout> | node ${posix(fakeRunner)} --model <nosedive-effort-model> --log ${posix(log)}`)}`,
			"---",
			"",
			"# Fake",
			"",
		].join("\n"),
	);
	return { bridge, log };
}

test("a prompt command prints its prompt when --exec is absent", () => {
	const { bridge } = createExecBridge("exec-print", ["effort-0-succeeds"]);

	const result = run(["into", "some context"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /some context/);
	assert.doesNotMatch(result.stdout, /dropped by/);
});

test("--exec runs the prompt and prints only the runner's stdout", () => {
	const { bridge, log } = createExecBridge("exec-runs", ["effort-0-succeeds"]);

	const result = run(["into", "some context", "--exec"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "dropped by effort-0-succeeds\n");
	assert.doesNotMatch(result.stdout, /some context/);
	assert.match(result.stderr, /into: effort 0, effort-0-succeeds/);
	// The prompt reached the runner rather than the pilot.
	assert.match(readFileSync(log, "utf8"), /some context/);
});

/**
 * `into` declares only `minimum-effort`, so the ceiling has to come from the
 * bridge. Succeeding at the last configured effort is what proves it did.
 */
test("--exec climbs to the highest configured effort and carries failures up", () => {
	const { bridge, log } = createExecBridge("exec-climbs", [
		"effort-0",
		"effort-1",
		"effort-2-succeeds",
	]);

	const result = run(["into", "some context", "--exec"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "dropped by effort-2-succeeds\n");
	assert.match(result.stderr, /into: effort 0 failed with exit 3/);
	assert.match(result.stderr, /into: effort 1 failed with exit 3/);

	const transcript = readFileSync(log, "utf8");
	const last = transcript.slice(transcript.lastIndexOf("=== effort-2-succeeds ==="));
	assert.match(last, /## Failed attempt at effort 0\n\nmodel: effort-0\nexit code: 3/);
	assert.match(last, /## Failed attempt at effort 1\n\nmodel: effort-1\nexit code: 3/);
	assert.match(last, /effort-0 gave up/, "the failed attempt's stderr rides along");
});

test("--exec fails when every configured effort fails", () => {
	const { bridge } = createExecBridge("exec-exhausted", ["effort-0", "effort-1"]);

	const result = run(["into", "some context", "--exec"], bridge);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /into exhausted every effort from 0 to 1/);
});

test("--exec refuses a command that does not output a prompt", () => {
	const { bridge } = createExecBridge("exec-not-a-prompt", ["effort-0-succeeds"]);

	const result = run(["whoami", "--exec"], bridge);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /whoami does not output a prompt, so --exec cannot run it/);
});

test("--exec refuses a ladder the bridge has not configured", () => {
	const { bridge } = createExecBridge("exec-no-ladder", []);

	const result = run(["into", "some context", "--exec"], bridge);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /has no agent-effort-<n>|is missing agent-effort-0/);
});

const refusals = [
	["reaches for the shell", "2>&1", /cannot use shell operators/],
	["pipes more than once", "| tee log", /must have exactly one pipe/],
	["names an unknown placeholder", "--key <api-key>", /unknown placeholder: <api-key>/],
];

for (const [label, tail, expected] of refusals) {
	test(`--exec refuses a runner usage that ${label}`, () => {
		const { bridge } = createExecBridge(
			`exec-usage-${label.replaceAll(" ", "-")}`,
			["effort-0-succeeds"],
			`<nosedive-command-stdout> | node runner.mjs --model <nosedive-effort-model> ${tail}`,
		);

		const result = run(["into", "some context", "--exec"], bridge);
		assert.equal(result.status, 1);
		assert.match(result.stderr, expected);
	});
}

test("--exec refuses a usage whose left side is not the prompt", () => {
	const { bridge } = createExecBridge(
		"exec-usage-backwards",
		["effort-0-succeeds"],
		"node runner.mjs --model <nosedive-effort-model> | <nosedive-command-stdout>",
	);

	const result = run(["into", "some context", "--exec"], bridge);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /must pipe <nosedive-command-stdout> into the runner/);
});
