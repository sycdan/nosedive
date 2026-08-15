import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, libUrl, write } from "../test-helpers.mjs";

const { collectDiveGates, collectLandGates } = await import(libUrl);
const tmp = createTmp("gate-verbs");

function fixture(name) {
	const bridge = createBridge(tmp, name);
	const landId = "01a00100-0000-7000-8000-000000000001";
	const testId = "01a00100-0000-7000-8000-000000000002";
	write(join(bridge, "kb", "land.mjs"), "export function run() {}\n");
	write(join(bridge, "kb", "test.mjs"), "export function run() {}\n");
	const landGate = {
		id: landId,
		relPath: `kb/${landId}.md`,
		links: [],
		metaScalars: { "test-script": "kb/land.mjs" },
	};
	const testGate = {
		id: testId,
		relPath: `kb/${testId}.md`,
		links: [],
		metaScalars: { "test-script": "kb/test.mjs" },
	};
	const root = {
		id: "01a00100-0000-7000-8000-000000000003",
		relPath: "kb/root.md",
		metaScalars: {},
		links: [
			{ id: landId, rel: "land.gate", attrs: {} },
			{ id: testId, rel: "test.gate", attrs: {} },
		],
	};
	return { bridge, docs: [root, landGate, testGate], landId, root, testId };
}

for (const [name, collect] of [
	["wide gate walk", (verb, root, docs, bridge) => collectLandGates(verb, [root], docs, bridge)],
	["direct gate links", collectDiveGates],
]) {
	test(`${name} selects only the requested verb`, () => {
		const { bridge, docs, landId, root, testId } = fixture(`${name.replaceAll(" ", "-")}-selects`);
		assert.deepEqual(
			collect("land", root, docs, bridge).map((gate) => gate.doc.id),
			[landId],
		);
		assert.deepEqual(
			collect("test", root, docs, bridge).map((gate) => gate.doc.id),
			[testId],
		);
	});

	test(`${name} refuses an unknown verb`, () => {
		const { bridge, docs, root } = fixture(`${name.replaceAll(" ", "-")}-refuses`);
		assert.throws(() => collect("deploy", root, docs, bridge), /unknown gate verb: deploy/);
	});
}
