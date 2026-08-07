import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("drop");
const promptId = "019fd9e1-26e2-785d-937b-d3c722074683";

/** A bridge holding a drop.prompt idea doc, which is all drop needs to print. */
function createDroppableBridge(tmp, name) {
	const bridge = createBridge(tmp, name);
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
	write(
		join(bridge, ".nosedive", "config.yaml"),
		[
			"compatibility-level: 2",
			"workspace: ./workspace",
			"kb: ./kb",
			`drop-prompt: ${promptId}`,
			"",
		].join("\n"),
	);
	return bridge;
}

function writeFeat(bridge, id, name, target) {
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
	const bridge = createDroppableBridge(tmp, "drop-future-bridge");
	writeFeat(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30a6",
		"judgement-day.release.nosedive",
		"2999-01-01",
	);

	const dropped = run(["drop", "judgement day"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "", "a refused drop prints no prompt");
	assert.match(dropped.stderr, /judgement-day\.release\.nosedive drops on 2999-01-01; today is /);
});

test("drop prints the release prompt on the target date and runs nothing", () => {
	const bridge = createDroppableBridge(tmp, "drop-today-bridge");
	writeFeat(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30a8", "today.release", isoDaysFromNow(0));

	const dropped = run(["drop", "today"], bridge);
	assert.equal(dropped.status, 0, dropped.stderr);
	assert.match(dropped.stdout, /Release the drop named below\./);
	assert.match(dropped.stdout, /^name: today\.release$/m);
});

test("drop generates the context block rather than trusting the prompt doc", () => {
	const bridge = createDroppableBridge(tmp, "drop-context-bridge");
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

	const dropped = run(["drop", "scoped"], bridge);
	assert.equal(dropped.status, 0, dropped.stderr);
	assert.match(dropped.stdout, /^name: scoped\.release$/m);
	assert.match(dropped.stdout, /^doc: kb\/019fd96e-b1f1-7770-aa0b-45d95c3b30b2\.md$/m);
	assert.match(dropped.stdout, new RegExp(`^target: ${target}$`, "m"));
	assert.match(dropped.stdout, /^ {2}- 019f514e-d8d5-7bc1-bf3f-d8e5092c6596 \(rw\)$/m);
});

/**
 * The point of the redesign: releasing is a pilot's decision, so the one
 * command that can ship software refuses to drive an agent itself.
 */
test("drop refuses --exec because releasing is human-only", () => {
	const bridge = createDroppableBridge(tmp, "drop-exec-bridge");
	writeFeat(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30b5", "manual.release", isoDaysFromNow(-1));

	const dropped = run(["drop", "manual", "--exec"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /drop does not output a prompt, so --exec cannot run it/);
});

test("drop refuses a feat with no target", () => {
	const bridge = createDroppableBridge(tmp, "drop-untargeted-bridge");
	writeFeat(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30a9", "undated.release");

	const dropped = run(["drop", "undated"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /has no meta\.target release date/);
});

test("drop refuses an ambiguous name and names the candidates", () => {
	const bridge = createDroppableBridge(tmp, "drop-ambiguous-bridge");
	writeFeat(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30aa", "twin.release", "2999-01-01");
	writeFeat(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30ab", "twin.development", "2999-01-01");

	const dropped = run(["drop", "twin"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /drop name is ambiguous: twin \(twin\.development, twin\.release\)/);
});

test("drop ignores an undated namesake when one candidate is dated", () => {
	const bridge = createDroppableBridge(tmp, "drop-namesake-bridge");
	writeFeat(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30ad", "judgement-day.release", "2999-01-01");
	writeFeat(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30ae", "judgement-day.gogglebox");

	const dropped = run(["drop", "judgement day"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /judgement-day\.release drops on 2999-01-01; today is /);
});

test("drop refuses a name that resolves to nothing", () => {
	const bridge = createDroppableBridge(tmp, "drop-missing-bridge");
	writeFeat(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30ac", "other.release", "2999-01-01");

	const dropped = run(["drop", "nothing here"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /drop not found: nothing here/);
});

test("drop requires a name", () => {
	const bridge = createDroppableBridge(tmp, "drop-nameless-bridge");

	const dropped = run(["drop"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /drop requires a name/);
});

test("drop refuses a prompt doc that is not the command's own idea", () => {
	const bridge = createDroppableBridge(tmp, "drop-badprompt-bridge");
	write(
		join(bridge, "kb", `${promptId}.md`),
		["---", "kind: memo", `id: ${promptId}`, "name: drop.prompt", "---", "", "# Nope", ""].join(
			"\n",
		),
	);
	writeFeat(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30b3",
		"badprompt.release",
		isoDaysFromNow(-1),
	);

	const dropped = run(["drop", "badprompt"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /must be kind: idea, not memo/);
});

test("drop needs no agent runner configured, because it never starts one", () => {
	const bridge = createDroppableBridge(tmp, "drop-runnerless-bridge");
	writeFeat(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30b6",
		"runnerless.release",
		isoDaysFromNow(-1),
	);

	const dropped = run(["drop", "runnerless"], bridge);
	assert.equal(dropped.status, 0, dropped.stderr);
	assert.ok(!existsSync(join(bridge, "runner.log")), "no runner should have been called");
});
