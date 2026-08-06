import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("path-rendering");

test("hydrate-repo.workspace renders paths with POSIX separators", () => {
	const bridge = createBridge(tmp, "bridge");
	const repoId = "019f8584-453f-79ea-9d53-5f1b20b4cda5";

	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: path-rendering
gist: "POSIX path rendering fixture."
meta:
  path: workspace\\path-rendering\\docs
---
`,
	);

	const result = run(["dehydrate-repo.workspace", repoId], bridge);
	assertOk(result, "dehydrate-repo.workspace failed");
	assert.match(result.stdout, /path=workspace\/path-rendering\/docs/);
	assert.doesNotMatch(result.stdout, /\\/);
});

test("path-bearing parse errors use POSIX separators", () => {
	const bridge = createBridge(tmp, "invalid-bridge");
	const effortId = "019f8584-453f-79ea-9d53-5f1b20b4cda8";
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: effort
id: ${effortId}
name: invalid-path-rendering
scopes: invalid
---
`,
	);

	const result = run(["hydrate-repo.workspace", effortId], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, new RegExp(`kb/${effortId}\\.md`));
	assert.doesNotMatch(result.stderr, /\\/);
});
