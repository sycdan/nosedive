import assert from "node:assert/strict";
import { test } from "node:test";

import { assertOk, createNoBridge, createTmp, handoffRunbookId, run } from "../test-helpers.mjs";

const tmp = createTmp("render");
const noBridge = createNoBridge(tmp);

test("render prints the full body by default", () => {
	const rendered = run(["render", handoffRunbookId], noBridge);
	assertOk(rendered, "render failed");
	assert.match(rendered.stdout, /^# Handoff$/m);
	assert.doesNotMatch(rendered.stdout, /^---$/m, "render should strip frontmatter delimiters");
});

test("render --gist prints only the gist field", () => {
	const rendered = run(["render", handoffRunbookId, "--gist"], noBridge);
	assertOk(rendered, "render --gist failed");
	assert.equal(
		rendered.stdout,
		"Before publishing a bridge with an active dive, capture scoped workspace work as binary patch artifacts in bridge kb, link them from the dive, dehydrate the workspace, then retry the bridge push.\n",
	);
	assert.doesNotMatch(rendered.stdout, /^# Handoff$/m, "render --gist should not print the body");
});

test("render needs no bridge", () => {
	const rendered = run(["render", handoffRunbookId, "--gist"], noBridge);
	assertOk(rendered, "render outside a bridge failed");
});

test("render rejects a missing uuid", () => {
	const missing = run(["render"], noBridge, "");
	assert.notEqual(missing.status, 0, "render without a uuid unexpectedly succeeded");
	assert.match(missing.stderr, /render requires exactly one uuid/);
});
