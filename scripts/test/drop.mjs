import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("drop");

function writeEffort(bridge, id, name, target) {
	const lines = ["---", "kind: effort", `id: ${id}`, `name: ${name}`, `gist: "${name}."`];
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

test("drop stops at the unbuilt release once the target date has passed", () => {
	const bridge = createBridge(tmp, "drop-past-bridge");
	writeEffort(
		bridge,
		"019fd96e-b1f1-7770-aa0b-45d95c3b30a7",
		"shipped.release",
		isoDaysFromNow(-1),
	);

	const dropped = run(["drop", "shipped"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /dropping is not implemented yet/);
});

test("drop passes the gate on the target date itself", () => {
	const bridge = createBridge(tmp, "drop-today-bridge");
	writeEffort(bridge, "019fd96e-b1f1-7770-aa0b-45d95c3b30a8", "today.release", isoDaysFromNow(0));

	const dropped = run(["drop", "today"], bridge);
	assert.equal(dropped.status, 1);
	assert.match(dropped.stderr, /dropping is not implemented yet/);
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
