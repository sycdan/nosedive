import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("run-gate");
const passId = "019fe100-0000-7000-8000-000000000001";
const failId = "019fe100-0000-7000-8000-000000000002";
const wrongKindId = "019fe100-0000-7000-8000-000000000003";

function gateDoc(id, kind = "assertion") {
	return `---
kind: ${kind}
id: ${id}
name: ${id}
gist: "Run gate fixture"
meta:
  test-script: kb/artifacts/${id}.mjs
---
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
	write(join(bridge, "kb", `${wrongKindId}.md`), gateDoc(wrongKindId, "memo"));
	return bridge;
}

test("run-gate runs a passing gate", () => {
	const result = run(["run-gate", passId], setup("passing"));
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "passed gate\n");
});

test("run-gate returns a failing gate status", () => {
	const result = run(["run-gate", failId], setup("failing"));
	assert.notEqual(result.status, 0);
	assert.equal(result.stderr, "failed gate\n");
});

test("run-gate clearly rejects an unknown id", () => {
	const result = run(["run-gate", "019fe100-0000-7000-8000-000000000099"], setup("unknown"));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /gate not found: 019fe100-0000-7000-8000-000000000099/);
});

test("run-gate clearly rejects a document with the wrong kind", () => {
	const result = run(["run-gate", wrongKindId], setup("wrong-kind"));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /has kind: memo; expected one of/);
});
