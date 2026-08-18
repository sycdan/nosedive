import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkSourceStructure } from "../check-source-structure.mjs";

function fixture(files, layers) {
	const rootPath = mkdtempSync(join(tmpdir(), "nosedive-source-structure-"));
	for (const [path, text] of Object.entries(files)) {
		const target = join(rootPath, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
	return {
		check: () => checkSourceStructure({ rootPath, layers }),
		remove: () => rmSync(rootPath, { recursive: true, force: true }),
	};
}

test("source structure permits a downward runtime import", () => {
	const source = fixture(
		{
			"entry.ts": 'import { value } from "./leaf.js";\nexport const result = value;\n',
			"leaf.ts": "export const value = 1;\n",
		},
		{ "entry.ts": 1, "leaf.ts": 0 },
	);
	try {
		assert.deepEqual(source.check().failures, []);
	} finally {
		source.remove();
	}
});

test("source structure rejects imports that point up a layer", () => {
	const source = fixture(
		{
			"leaf.ts": 'import { value } from "./entry.js";\nexport const result = value;\n',
			"entry.ts": "export const value = 1;\n",
		},
		{ "leaf.ts": 0, "entry.ts": 1 },
	);
	try {
		assert.match(
			source.check().failures.join("\n"),
			/leaf\.ts \(layer 0\) imports entry\.ts \(layer 1\).*Move a shared helper down or move the caller up/,
		);
	} finally {
		source.remove();
	}
});

test("source structure rejects a source file without a declared layer", () => {
	const source = fixture({ "missing.ts": "export const value = 1;\n" }, {});
	try {
		assert.match(source.check().failures.join("\n"), /missing\.ts has no declared source layer/);
	} finally {
		source.remove();
	}
});

test("source structure reports a complete runtime import cycle", () => {
	const source = fixture(
		{
			"first.ts": 'import { second } from "./second.js";\nexport const first = second;\n',
			"second.ts": 'import { first } from "./first.js";\nexport const second = first;\n',
		},
		{ "first.ts": 1, "second.ts": 0 },
	);
	try {
		assert.match(
			source.check().failures.join("\n"),
			/Source import cycle: first\.ts -> second\.ts -> first\.ts/,
		);
	} finally {
		source.remove();
	}
});

test("source structure ignores type-only imports", () => {
	const source = fixture(
		{
			"consumer.ts": 'import type { Value } from "./types.js";\nexport type Alias = Value;\n',
			"types.ts": "export type Value = string;\n",
		},
		{ "consumer.ts": 0, "types.ts": 0 },
	);
	try {
		assert.deepEqual(source.check().failures, []);
	} finally {
		source.remove();
	}
});

test("source structure checks runtime re-exports", () => {
	const source = fixture(
		{
			"entry.ts": 'export { value } from "./leaf.js";\n',
			"leaf.ts": "export const value = 1;\n",
		},
		{ "entry.ts": 1, "leaf.ts": 0 },
	);
	try {
		assert.deepEqual(source.check().failures, []);
	} finally {
		source.remove();
	}
});
