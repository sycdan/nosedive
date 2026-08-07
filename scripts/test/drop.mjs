import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, root, run, write } from "../test-helpers.mjs";

const tmp = createTmp("drop");
const fakeRunner = join(root, "scripts", "test", "fixtures", "fake-runner.mjs");
const runnerId = "019fd9e1-26e2-785d-937b-d3c722074682";
const promptId = "019fd9e1-26e2-785d-937b-d3c722074683";

/** A bridge wired to the fake runner, with one model per effort tier. */
function createRunnableBridge(tmp, name, models) {
	const bridge = createBridge(tmp, name);
	const log = join(bridge, "runner.log");
	write(
		join(bridge, ".nosedive", "config.yaml"),
		[
			"compatibility-level: 2",
			"workspace: ./workspace",
			"kb: ./kb",
			`agent-runner: ${runnerId}`,
			...models.map((model, tier) => `agent-effort-${tier}: ${model}`),
			`drop-prompt: ${promptId}`,
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
			`  cold-start-usage: "<nosedive-command-stdout> | node ${fakeRunner.replaceAll("\\", "/")} --model <nosedive-effort-model> --log ${log.replaceAll("\\", "/")}"`,
			"---",
			"",
			"# Fake",
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${promptId}.md`),
		[
			"---",
			"kind: idea",
			`id: ${promptId}`,
			"name: drop.prompt",
			'gist: "Drop prompt."',
			"---",
			"",
			"# Drop It",
			"",
			"Release the drop named below.",
			"",
		].join("\n"),
	);
	return { bridge, log };
}

function writeEffort(bridge, id, name, target) {
	const lines = ["---", "kind: feat", `id: ${id}`, `name: ${name}`, `gist: "${name}."`];
	if (target) lines.push("meta:", `  target: ${target}`);
	lines.push("---", "", `# ${name}`, "");
	write(join(bridge, "kb", `${id}.md`), lines.join("\n"));
}

function isoDaysFromNow(days) {
	const date = new Date();
	date.setDate(date.getDate() + days);
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test("drop refuses a target date that has not been reached", () => {
	const bridge = createBridge(tmp, "drop-future-bridge");
	writeEffort(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30a6",
		"judgement-day.release.nosedive",
		"2999-01-01",
	);

	const dropped = run(["drop", "judgement day"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /judgement-day\.release\.nosedive drops on 2999-01-01; today is /);
});

test("drop refuses a ladder the bridge has not configured", () => {
	const bridge = createBridge(tmp, "drop-past-bridge");
	writeEffort(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30a7",
		"shipped.release",
		isoDaysFromNow(-1),
	);

	const dropped = run(["drop", "shipped"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /is missing agent-effort-0, agent-effort-1, agent-effort-2/);
});

test("drop passes the gate on the target date itself", () => {
	const { bridge } = createRunnableBridge(tmp, "drop-today-bridge", [
		"tier-0-succeeds",
		"tier-1",
		"tier-2",
	]);
	writeEffort(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30a8", "today.release", isoDaysFromNow(0));

	const dropped = run(["drop", "today"], bridge);
	assert.equal(dropped.status, 0);
	assert.match(dropped.stdout, /dropped by tier-0-succeeds/);
});

test("drop escalates to the next tier and carries the failures with it", () => {
	const { bridge, log } = createRunnableBridge(tmp, "drop-escalate-bridge", [
		"tier-0",
		"tier-1",
		"tier-2-succeeds",
	]);
	writeEffort(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30b0",
		"escalate.release",
		isoDaysFromNow(-1),
	);

	const dropped = run(["drop", "escalate"], bridge);
	assert.equal(dropped.status, 0);
	assert.equal(dropped.stdout, "dropped by tier-2-succeeds\n");
	assert.match(dropped.stderr, /drop: effort 0, tier-0/);
	assert.match(dropped.stderr, /drop: effort 0 failed with exit 3/);
	assert.match(dropped.stderr, /drop: effort 2 dropped escalate\.release/);

	assert.ok(existsSync(log), "the runner was never called");
	const transcript = readFileSync(log, "utf8");
	const lastPrompt = transcript.slice(transcript.lastIndexOf("=== tier-2-succeeds ==="));
	assert.match(lastPrompt, /Release the drop named below\./);
	assert.match(lastPrompt, /## Failed attempt at effort 0\n\nmodel: tier-0\nexit code: 3/);
	assert.match(lastPrompt, /## Failed attempt at effort 1\n\nmodel: tier-1\nexit code: 3/);
	assert.match(lastPrompt, /tier-0 gave up/);
});

test("drop fails when the maximum effort tier fails", () => {
	const { bridge } = createRunnableBridge(tmp, "drop-exhausted-bridge", [
		"tier-0",
		"tier-1",
		"tier-2",
	]);
	writeEffort(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30b1",
		"exhausted.release",
		isoDaysFromNow(-1),
	);

	const dropped = run(["drop", "exhausted"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "");
	assert.match(
		dropped.stderr,
		/exhausted\.release was not dropped: every effort from 0 to 2 failed/,
	);
});

test("drop generates the context block rather than trusting the prompt doc", () => {
	const { bridge, log } = createRunnableBridge(tmp, "drop-context-bridge", [
		"tier-0-succeeds",
		"tier-1",
		"tier-2",
	]);
	const target = isoDaysFromNow(-1);
	write(
		join(bridge, "kb", "019fd96e-b1f1-7770-aa0b-45d95c3b30b2.md"),
		[
			"---",
			"kind: feat",
			"id: 019fd96e-b1f1-7770-aa0b-45d95c3b30b2",
			"name: scoped.release",
			'gist: "Scoped."',
			"scopes:",
			"  - 019f514e-d8d5-7bc1-bf3f-d8e5092c6596",
			"meta:",
			`  target: ${target}`,
			"---",
			"",
			"# Scoped",
			"",
		].join("\n"),
	);

	assert.equal(run(["drop", "scoped"], bridge).status, 0);
	const prompt = readFileSync(log, "utf8");
	assert.match(prompt, /^name: scoped\.release$/m);
	assert.match(prompt, /^doc: kb\/019fd96e-b1f1-7770-aa0b-45d95c3b30b2\.md$/m);
	assert.match(prompt, new RegExp(`^target: ${target}$`, "m"));
	assert.match(prompt, /^ {2}- 019f514e-d8d5-7bc1-bf3f-d8e5092c6596 \(rw\)$/m);
});

test("drop refuses a prompt doc that is not the command's own idea", () => {
	const { bridge } = createRunnableBridge(tmp, "drop-badprompt-bridge", [
		"tier-0-succeeds",
		"tier-1",
		"tier-2",
	]);
	write(
		join(bridge, "kb", `${promptId}.md`),
		["---", "kind: memo", `id: ${promptId}`, "name: drop.prompt", "---", "", "# Nope", ""].join(
			"\n",
		),
	);
	writeEffort(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30b3",
		"badprompt.release",
		isoDaysFromNow(-1),
	);

	const dropped = run(["drop", "badprompt"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /must be kind: idea, not memo/);
});

/** Swap in a usage string that should never reach a spawn, and say why it did not. */
function assertUsageRefused(name, usage, expected) {
	const { bridge } = createRunnableBridge(tmp, `drop-${name}-bridge`, [
		"tier-0-succeeds",
		"tier-1",
		"tier-2",
	]);
	write(
		join(bridge, "kb", `${runnerId}.md`),
		[
			"---",
			"kind: memo",
			`id: ${runnerId}`,
			"name: fake.agent-runner",
			'gist: "Fake runner."',
			"meta:",
			`  cold-start-usage: ${JSON.stringify(usage)}`,
			"---",
			"",
			"# Fake",
			"",
		].join("\n"),
	);
	writeEffort(
		bridge,
		`019fd9ff-b1f1-7770-aa0b-45d95c3b3${name.length}0a`,
		`${name}.release`,
		"2020-01-01",
	);

	const dropped = run(["drop", name], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, expected);
}

test("drop refuses a usage that reaches for the shell", () => {
	assertUsageRefused(
		"redirect",
		"<nosedive-command-stdout> | node runner.mjs --model <nosedive-effort-model> 2>&1",
		/cannot use shell operators/,
	);
});

test("drop refuses a usage that pipes more than once", () => {
	assertUsageRefused(
		"tee",
		"<nosedive-command-stdout> | node runner.mjs --model <nosedive-effort-model> | tee log",
		/must have exactly one pipe/,
	);
});

test("drop refuses a usage whose left side is not the prompt", () => {
	assertUsageRefused(
		"backwards",
		"node runner.mjs --model <nosedive-effort-model> | <nosedive-command-stdout>",
		/must pipe <nosedive-command-stdout> into the runner/,
	);
});

test("drop refuses a runner usage with an unknown placeholder", () => {
	const { bridge } = createRunnableBridge(tmp, "drop-badusage-bridge", [
		"tier-0-succeeds",
		"tier-1",
		"tier-2",
	]);
	write(
		join(bridge, "kb", `${runnerId}.md`),
		[
			"---",
			"kind: memo",
			`id: ${runnerId}`,
			"name: fake.agent-runner",
			'gist: "Fake runner."',
			"meta:",
			'  cold-start-usage: "<nosedive-command-stdout> | node runner.mjs --model <nosedive-effort-model> --key <api-key>"',
			"---",
			"",
			"# Fake",
			"",
		].join("\n"),
	);
	writeEffort(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30b4",
		"badusage.release",
		isoDaysFromNow(-1),
	);

	const dropped = run(["drop", "badusage"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /unknown placeholder: <api-key>/);
});

test("drop refuses an effort with no target", () => {
	const bridge = createBridge(tmp, "drop-untargeted-bridge");
	writeEffort(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30a9", "undated.release");

	const dropped = run(["drop", "undated"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /has no meta\.target release date/);
});

test("drop refuses an ambiguous name and names the candidates", () => {
	const bridge = createBridge(tmp, "drop-ambiguous-bridge");
	writeEffort(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30aa", "twin.release", "2999-01-01");
	writeEffort(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30ab", "twin.development", "2999-01-01");

	const dropped = run(["drop", "twin"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /drop name is ambiguous: twin \(twin\.development, twin\.release\)/);
});

test("drop ignores an undated namesake when one candidate is dated", () => {
	const bridge = createBridge(tmp, "drop-namesake-bridge");
	writeEffort(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30ad",
		"judgement-day.release",
		"2999-01-01",
	);
	writeEffort(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30ae", "judgement-day.gogglebox");

	const dropped = run(["drop", "judgement day"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /judgement-day\.release drops on 2999-01-01; today is /);
});

test("drop refuses a name that resolves to nothing", () => {
	const bridge = createBridge(tmp, "drop-missing-bridge");
	writeEffort(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30ac", "other.release", "2999-01-01");

	const dropped = run(["drop", "nothing here"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /drop not found: nothing here/);
});

test("drop requires a name", () => {
	const bridge = createBridge(tmp, "drop-nameless-bridge");

	const dropped = run(["drop"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /drop requires a name/);
});
