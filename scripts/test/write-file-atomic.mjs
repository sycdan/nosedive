import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

import { createTmp } from "../test-helpers.mjs";

test("writeFileAtomic retries an EPERM rename and writes the destination", async () => {
	const tmp = createTmp("write-file-atomic");
	const moduleDir = join(tmp, "module");
	mkdirSync(moduleDir, { recursive: true });

	const sourcePath = join(process.cwd(), "src", "lib", "renderPlan.ts");
	const original = readFileSync(sourcePath, "utf8");
	const source = original.replace(
		'import { mkdirSync, renameSync, writeFileSync } from "node:fs";',
		'import { mkdirSync, renameSync, writeFileSync } from "./fs-stub.js";',
	);
	// Without this the substitution could silently miss, the module would use the
	// real fs, the rename would succeed first try, and the test would pass having
	// exercised no retry at all.
	assert.notEqual(source, original, "the fs import in renderPlan.ts was not stubbed");
	const transpiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ES2022,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	writeFileSync(join(moduleDir, "renderPlan.js"), transpiled, "utf8");
	writeFileSync(
		join(moduleDir, "gitProcess.js"),
		'export function runGit() { return { status: 0, stdout: "", stderr: "" }; }\n',
		"utf8",
	);
	writeFileSync(
		join(moduleDir, "fs-stub.js"),
		[
			'import { mkdirSync as realMkdirSync, writeFileSync as realWriteFileSync, readFileSync as realReadFileSync } from "node:fs";',
			"let renameCalls = 0;",
			"export function mkdirSync(...args) { return realMkdirSync(...args); }",
			"export function writeFileSync(...args) { return realWriteFileSync(...args); }",
			"export function renameSync(tmp, target) {",
			"  renameCalls += 1;",
			"  if (renameCalls === 1) {",
			'    const error = new Error("EPERM");',
			'    error.code = "EPERM";',
			"    throw error;",
			"  }",
			'  return realWriteFileSync(target, realReadFileSync(tmp, "utf8"), "utf8");',
			"}",
			"export function renameCallCount() { return renameCalls; }",
		].join("\n"),
		"utf8",
	);

	const moduleUrl = pathToFileURL(join(moduleDir, "renderPlan.js")).href;
	const { writeFileAtomic } = await import(moduleUrl);
	const targetPath = join(tmp, "output.txt");
	const content = "hello from retry\n";

	writeFileAtomic(targetPath, content);

	assert.equal(readFileSync(targetPath, "utf8"), content);
	const { renameCallCount } = await import(pathToFileURL(join(moduleDir, "fs-stub.js")).href);
	assert.equal(renameCallCount(), 2, "the rename should have been retried exactly once");
});
