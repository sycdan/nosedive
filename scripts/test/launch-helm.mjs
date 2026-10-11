import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { cli, cliEnv, createTmp, libUrl, root } from "../test-helpers.mjs";

const tmp = createTmp("launch-helm");

/** Runs `nosedive helm` with `env` laid over the test env. */
function helm(args, env) {
	return spawnSync(process.execPath, [cli, "helm", ...args], {
		cwd: tmp,
		encoding: "utf8",
		env: { ...cliEnv(), ...env },
	});
}

test("nosedive helm runs the helm NOSEDIVE_HELM names, against this core, and exits with its code", () => {
	const seen = join(tmp, "seen.json");
	const standIn = join(tmp, "stand-in-helm.mjs");
	writeFileSync(
		standIn,
		`import { writeFileSync } from "node:fs";
const { NOSEDIVE_CORE, NOSEDIVE_CLI, NOSEDIVE_PROTOCOL } = process.env;
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), NOSEDIVE_CORE, NOSEDIVE_CLI, NOSEDIVE_PROTOCOL }));
process.stdout.write("helm says hi\\n");
process.exit(3);
`,
	);
	const result = helm(["2026-10-11-test", "--flag"], { NOSEDIVE_HELM: standIn });
	assert.equal(result.status, 3, result.stderr);
	assert.match(result.stdout, /helm says hi/);
	const got = JSON.parse(readFileSync(seen, "utf8"));
	assert.deepEqual(got.args, ["2026-10-11-test", "--flag"]);
	assert.equal(got.NOSEDIVE_CORE, root);
	assert.equal(got.NOSEDIVE_CLI, join(root, "dist", "cli.js"));
	assert.equal(got.NOSEDIVE_PROTOCOL, "1");
});

test("with no helm installed, nosedive helm says so and exits 1", () => {
	const empty = join(tmp, "empty-path");
	mkdirSync(empty, { recursive: true });
	const result = helm([], { NOSEDIVE_HELM: "", PATH: empty, Path: empty });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /helm is not installed/);
});

test("the core API nosedive-helm imports resolves from this package's entry", async () => {
	const core = await import(libUrl);
	assert.equal(core.HELM_PROTOCOL, 1);
	const source = readFileSync(join(root, "src", "nosedive.ts"), "utf8");
	const block = source.slice(
		source.indexOf("// --- core API for nosedive-helm"),
		source.indexOf("// --- end of the core API for nosedive-helm"),
	);
	const names = [...block.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*),?$|export \{ ([^}]+) \}/gm)]
		.flatMap((m) => (m[1] ? [m[1]] : m[2].split(",")))
		.map((name) => name.trim())
		.filter((name) => name && !name.startsWith("type "));
	assert.ok(names.length > 30, `read ${names.length} names from the block`);
	for (const name of names) assert.notEqual(core[name], undefined, `${name} is exported`);
});
