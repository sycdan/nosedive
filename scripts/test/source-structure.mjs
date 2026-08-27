import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkSourceStructure } from "../check-source-structure.mjs";

function boundary(id, name, allows) {
	return { id, name, allows };
}

function fixture(files, boundaries) {
	const rootPath = mkdtempSync(join(tmpdir(), "nosedive-source-structure-"));
	for (const [path, text] of Object.entries(files)) {
		const target = join(rootPath, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
	return {
		check: () => checkSourceStructure({ rootPath, boundaryFor: (path) => boundaries[path] }),
		remove: () => rmSync(rootPath, { recursive: true, force: true }),
	};
}

test("source structure permits a downward runtime import", () => {
	const source = fixture(
		{
			"entry.ts": 'import { value } from "./leaf.js";\nexport const result = value;\n',
			"leaf.ts": "export const value = 1;\n",
		},
		{
			"entry.ts": boundary("entrypoint", "entrypoint", ["entrypoint", "core"]),
			"leaf.ts": boundary("core", "shared core", ["core"]),
		},
	);
	try {
		assert.deepEqual(source.check().failures, []);
	} finally {
		source.remove();
	}
});

test("source structure permits imports within one boundary", () => {
	const source = fixture(
		{
			"impl/first.ts": 'import { second } from "./second.js";\nexport const first = second;\n',
			"impl/second.ts": "export const second = 1;\n",
		},
		{
			"impl/first.ts": boundary("impl", "implementation", ["impl", "core"]),
			"impl/second.ts": boundary("impl", "implementation", ["impl", "core"]),
		},
	);
	try {
		assert.deepEqual(source.check().failures, []);
	} finally {
		source.remove();
	}
});

test("source structure recognizes a runtime plain ESM helper", () => {
	const source = fixture(
		{
			"contractDocs.ts":
				'import { format } from "./lib/format.mjs";\nexport const help = format();\n',
			"lib/format.mjs": 'export function format() { return "help"; }\n',
		},
		{
			"contractDocs.ts": boundary("docs", "contract discovery", ["docs", "core"]),
			"lib/format.mjs": boundary("core", "shared core", ["core"]),
		},
	);
	try {
		assert.deepEqual(source.check().failures, []);
	} finally {
		source.remove();
	}
});

test("source structure rejects imports that point up a boundary", () => {
	const source = fixture(
		{
			"core.ts": 'import { value } from "./entry.js";\nexport const result = value;\n',
			"entry.ts": "export const value = 1;\n",
		},
		{
			"core.ts": boundary("core", "shared core", ["core"]),
			"entry.ts": boundary("entrypoint", "entrypoint", ["entrypoint", "core"]),
		},
	);
	try {
		assert.match(
			source.check().failures.join("\n"),
			/core\.ts \(shared core\) imports entry\.ts \(entrypoint\), which is not allowed\. shared core may import only: shared core\./,
		);
	} finally {
		source.remove();
	}
});

test("source structure rejects a sibling boundary without an allowed direction", () => {
	const source = fixture(
		{
			"impl/command.ts": 'import { read } from "../contractDocs.js";\nexport const run = read;\n',
			"contractDocs.ts": "export const read = 1;\n",
		},
		{
			"impl/command.ts": boundary("impl", "command implementation", ["impl", "core"]),
			"contractDocs.ts": boundary("docs", "contract discovery", ["docs", "core"]),
		},
	);
	try {
		assert.match(
			source.check().failures.join("\n"),
			/command implementation may import only: command implementation, shared core/,
		);
	} finally {
		source.remove();
	}
});

test("source structure rejects a source file without a declared boundary", () => {
	const source = fixture({ "missing.ts": "export const value = 1;\n" }, {});
	try {
		assert.match(
			source.check().failures.join("\n"),
			/missing\.ts has no declared source boundary.*lib\/\*\*/,
		);
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
		{
			"first.ts": boundary("impl", "implementation", ["impl", "core"]),
			"second.ts": boundary("impl", "implementation", ["impl", "core"]),
		},
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
		{
			"consumer.ts": boundary("core", "shared core", ["core"]),
			"types.ts": boundary("core", "shared core", ["core"]),
		},
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
		{
			"entry.ts": boundary("entrypoint", "entrypoint", ["entrypoint", "core"]),
			"leaf.ts": boundary("core", "shared core", ["core"]),
		},
	);
	try {
		assert.deepEqual(source.check().failures, []);
	} finally {
		source.remove();
	}
});
