import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createBridge,
	createNoBridge,
	createTmp,
	run,
	runTool,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("bridge-resolution");

/**
 * `preflight` reads the pilot through `git config user.name`, which the author
 * and committer variables `run` exports do not satisfy. A developer's global
 * config supplies one and hides that; a CI runner has none, so a bridge these
 * tests drive preflight against has to carry its own.
 */
function identifiedBridge(parent, name, options) {
	const bridge = createBridge(parent, name, options);
	runTool("git", ["config", "user.name", "Resolution Test"], bridge);
	runTool("git", ["config", "user.email", "resolution@example.invalid"], bridge);
	return bridge;
}

function assertWorkspace(result, workspace) {
	assertOk(result, "preflight failed");
	assert.equal(
		/^nosedive-workspace: (.+)$/m.exec(result.stdout)?.[1],
		resolve(workspace).replaceAll("\\", "/"),
	);
}

test("a seeded repo inside a bridge workspace resolves the outer bridge", () => {
	const outer = identifiedBridge(tmp, "outer");
	const inner = join(outer, "workspace", "inner");
	writeBridgeConfig(inner);

	assertWorkspace(run(["preflight"], inner), join(outer, "workspace"));
});

test("a nested bridge outside the outer workspace resolves itself", () => {
	const outer = createBridge(tmp, "outer2");
	const nested = identifiedBridge(outer, join("vendor", "their-bridge"));

	assertWorkspace(run(["preflight"], nested), join(nested, "workspace"));
});

// An out-of-tree workspace is the one shape the resolution rule cannot cover:
// the declaring bridge never appears on the path walked up from a repo inside
// that workspace, so there is no candidate to disqualify the repo with.
test("seed refuses a workspace that resolves outside the bridge", () => {
	const bridge = createBridge(tmp, "outside-workspace", { workspace: "../elsewhere" });

	const result = run(["seed", "--headless", "--file", "AGENTS.md"], bridge);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /workspace must be inside the bridge/);
	assert.match(result.stderr, /\.\.\/elsewhere/);
});

test("a directory without a bridge still reports missing config", () => {
	const result = run(["preflight"], createNoBridge(tmp));

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /\.nosedive\/config\.yaml/);
	assert.match(result.stderr, /\.nosediverc/);
});
