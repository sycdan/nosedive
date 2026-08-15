import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, root, run } from "../test-helpers.mjs";

const tmp = createTmp("compatibility-level");

/**
 * The publish workflow derives the `level-<n>` dist-tag from this script, and a
 * workflow step cannot be exercised from the suite. What can be checked is that
 * the script and the built CLI agree.
 *
 * The script reads the constant out of `src/lib`; `seed` writes the level the
 * *compiled* constant carries into a fresh bridge's config. Comparing the two
 * is the only assertion here that is not circular -- it fails if the script's
 * read drifts from what actually ships, which is exactly the way a wrong tag
 * would get published without anything noticing.
 */
test("compatibility-level agrees with the level seed writes", () => {
	const bridge = createBridge(tmp, "level");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const config = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const seeded = /^compatibility-level: (\d+)$/m.exec(config)?.[1];
	assert.ok(seeded, `seed wrote no compatibility-level:\n${config}`);

	const result = spawnSync(process.execPath, [join(root, "scripts", "compatibility-level.mjs")], {
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), seeded);
});
