import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("test");
const passId = "019fe100-0000-7000-8000-000000000001";
const failId = "019fe100-0000-7000-8000-000000000002";
const wrongKindId = "019fe100-0000-7000-8000-000000000003";

function gateDoc(id, kind = "assertion", { script = `kb/artifacts/${id}.mjs` } = {}) {
	const meta = script === null ? "meta:\n" : `meta:\n  test-script: ${script}\n`;
	return `---
kind: ${kind}
id: ${id}
name: ${id}
gist: "Run gate fixture"
${meta}---
`;
}

function setup(name) {
	const bridge = createBridge(tmp, name);
	write(join(bridge, "kb", `${passId}.md`), gateDoc(passId));
	write(
		join(bridge, "kb", "artifacts", `${passId}.mjs`),
		'export function run() { console.log("passed gate"); }\n',
	);
	write(join(bridge, "kb", `${failId}.md`), gateDoc(failId));
	write(
		join(bridge, "kb", "artifacts", `${failId}.mjs`),
		'export function run() { console.error("failed gate"); return false; }\n',
	);
	write(join(bridge, "kb", `${wrongKindId}.md`), gateDoc(wrongKindId, "memo", { script: null }));
	return bridge;
}

test("test runs a passing gate", () => {
	const result = run(["test", passId], setup("passing"));
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "passed gate\n");
});

test("test returns a failing gate status", () => {
	const result = run(["test", failId], setup("failing"));
	assert.notEqual(result.status, 0);
	assert.equal(result.stderr, "failed gate\n");
});

test("test clearly rejects an unknown id", () => {
	const result = run(["test", "019fe100-0000-7000-8000-000000000099"], setup("unknown"));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /gate not found: 019fe100-0000-7000-8000-000000000099/);
});

test("test clearly rejects a document with no test-script", () => {
	const result = run(["test", wrongKindId], setup("wrong-kind"));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /meta\.test-script is missing/);
});

const diveId = "019fe100-0000-7000-8000-000000000010";
const featId = "019fe100-0000-7000-8000-000000000011";
const featGateId = "019fe100-0000-7000-8000-000000000012";

function gateLink(id) {
	return `  - kb/${id}.md:\n      rel: land.gate\n`;
}

/**
 * A bridge whose dive claims one gate directly and whose feat claims another,
 * which is the only shape that can tell the two selections apart: with no
 * arguments only the dive's gate may run, and `--full` must reach both.
 */
function setupDive(name, { diveGates = [passId], featGates = [featGateId] } = {}) {
	const bridge = setup(name);
	write(join(bridge, "kb", `${featGateId}.md`), gateDoc(featGateId));
	write(
		join(bridge, "kb", "artifacts", `${featGateId}.mjs`),
		'export function run() { console.log("feat gate ran"); }\n',
	);
	write(
		join(bridge, "kb", `${featId}.md`),
		`---\nkind: feat\nid: ${featId}\nname: test-selection.nosedive\ngist: "Selection fixture"\n` +
			`links:\n${featGates.map(gateLink).join("")}---\n`,
	);
	write(
		join(bridge, "kb", `${diveId}.md`),
		`---\nkind: dive\nid: ${diveId}\nname: test-selection.nosedive.abc123\ngist: "Selection fixture"\n` +
			`scopes: []\nmeta:\n  effort: ${featId}\n` +
			`links:\n${diveGates.map(gateLink).join("")}---\n\n# Dive\n`,
	);
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${diveId}\n`);
	return bridge;
}

test("test with no arguments runs the dive's own gates and nothing else", () => {
	const result = run(["test"], setupDive("dive-scoped"));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /passed gate/);
	assert.doesNotMatch(result.stdout, /feat gate ran/, "the feat's gate is not dive-resident");
});

test("test --full reaches gates the dive does not claim itself", () => {
	const result = run(["test", "--full"], setupDive("full-walk"));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /passed gate/);
	assert.match(result.stdout, /feat gate ran/);
	assert.match(result.stderr, /2 gate\(s\) in .*: 2 passed, 0 failed/);
});

test("test refuses without an active dive, and says so by name", () => {
	const bridge = setupDive("no-dive");
	rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });
	const result = run(["test"], bridge);
	assert.notEqual(result.status, 0);
	// The id, not the prose: this asserts which error was raised, not how it reads.
	assert.match(result.stderr, /019fe2f7-5922-72d5-abda-b5b8cb7300cf/);
	assert.match(result.stderr, /active dive, and there isn't one/);
});

test("test still runs a named gate without any dive on deck", () => {
	const bridge = setupDive("named-without-dive");
	rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });
	const result = run(["test", passId], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "passed gate\n");
});

test("every gate runs even after one fails, and all failures are reported once", () => {
	const failB = "019fe100-0000-7000-8000-000000000013";
	const failC = "019fe100-0000-7000-8000-000000000014";
	const bridge = setupDive("collect-failures", { diveGates: [failId, failB, failC] });
	for (const id of [failB, failC]) {
		write(join(bridge, "kb", `${id}.md`), gateDoc(id));
		write(
			join(bridge, "kb", "artifacts", `${id}.mjs`),
			`export function run() { console.error("failed ${id}"); return false; }\n`,
		);
	}

	const result = run(["test"], bridge);
	assert.equal(result.status, 1, "a failing set must exit 1");
	assert.match(result.stderr, /3 gate\(s\) in .*: 0 passed, 3 failed/);
	for (const id of [failId, failB, failC]) {
		assert.equal(
			result.stderr.split(`FAILED  ${id}`).length - 1,
			1,
			`${id} should be named exactly once in the summary`,
		);
	}
});

test("a dive gate needs no gate-height", () => {
	const bridge = setupDive("no-height");
	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.doesNotMatch(diveText, /gate-height/, "the fixture must not set one");
	assert.equal(run(["test"], bridge).status, 0);
});

test("a dive that links no gates is reported rather than called green", () => {
	const result = run(["test"], setupDive("no-gates", { diveGates: [] }));
	assert.notEqual(result.status, 0, "zero gates must never be success");
	assert.match(result.stderr, /links no gates/);
});
