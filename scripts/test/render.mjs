import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createNoBridge,
	createTmp,
	handoffRunbookId,
	root,
	run,
} from "../test-helpers.mjs";

const tmp = createTmp("render");
const noBridge = createNoBridge(tmp);

test("render prints the full body by default", () => {
	const rendered = run(["render", handoffRunbookId], noBridge);
	assertOk(rendered, "render failed");
	assert.match(rendered.stdout, /^# Handoff$/m);
	assert.doesNotMatch(rendered.stdout, /^---$/m, "render should strip frontmatter delimiters");
});

test("render makes packaged kb links followable from the current directory", () => {
	const rendered = run(["render", "9e3a676a-6d2f-5b93-93af-f4608ed28843"], noBridge);
	assertOk(rendered, "render with a packaged kb link failed");
	const target = relative(
		noBridge,
		join(root, "kb", "9822f048-0b75-5ed3-b912-fb566e31d9e8.md"),
	).replaceAll("\\", "/");
	assert.ok(rendered.stdout.includes(`[dive](${target})`), "render did not rewrite the kb link");
});

test("render leaves anchors and Markdown examples in code unchanged", () => {
	const rendered = run(["render", "0000000f-4240-7a62-8f61-a85b4c364560"], noBridge);
	assertOk(rendered, "render with anchors and code examples failed");
	assert.match(rendered.stdout, /\[the grep below\]\(#finding-a-canonical-definition\)/);
	assert.match(
		rendered.stdout,
		/`\[README\]\(\.\.\/<nosedive-workspace>\/<dirname>\/README\.md\)`/,
	);
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
