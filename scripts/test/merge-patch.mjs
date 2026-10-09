import assert from "node:assert/strict";
import { test } from "node:test";

import { libUrl } from "../test-helpers.mjs";

const { mergePatch } = await import(libUrl);

// RFC 7386, Appendix A: original, patch, result.
const EXAMPLES = [
	[{ a: "b" }, { a: "c" }, { a: "c" }],
	[{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
	[{ a: "b" }, { a: null }, {}],
	[{ a: "b", b: "c" }, { a: null }, { b: "c" }],
	[{ a: ["b"] }, { a: "c" }, { a: "c" }],
	[{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
	[{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
	[{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
	[
		["a", "b"],
		["c", "d"],
		["c", "d"],
	],
	[{ a: "b" }, ["c"], ["c"]],
	[{ a: "foo" }, null, null],
	[{ a: "foo" }, "bar", "bar"],
	[{ e: null }, { a: 1 }, { e: null, a: 1 }],
	[[1, 2], { a: "b", c: null }, { a: "b" }],
	[{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
];

test("mergePatch gives RFC 7386's result for every example in its appendix", () => {
	for (const [original, patch, result] of EXAMPLES) {
		assert.deepEqual(mergePatch(original, patch), result, JSON.stringify({ original, patch }));
	}
});

test("mergePatch leaves its target untouched", () => {
	const original = { a: { b: "c" } };
	mergePatch(original, { a: { b: null } });
	assert.deepEqual(original, { a: { b: "c" } });
});
