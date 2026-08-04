import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("path-rendering");

test("list-dives renders source paths with POSIX separators", () => {
	const bridge = createBridge(tmp, "bridge");
	const effortId = "019f8584-453f-79ea-9d53-5f1b20b4cda5";
	const diveId = "019f8584-453f-79ea-9d53-5f1b20b4cda6";

	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: effort
id: ${effortId}
name: path-rendering
gist: "POSIX path rendering fixture."
links:
  - kb/${diveId}.md:
      rel: pending
---
`,
	);
	write(
		join(bridge, "kb", `${diveId}.md`),
		`---
kind: dive
id: ${diveId}
name: path-rendering.pending
gist: "Pending path rendering dive."
effort: kb/${effortId}.md
scopes:
  - 019f8584-453f-79ea-9d53-5f1b20b4cda7:
      path: docs\\api
---
`,
	);

	const result = run(["list-dives", effortId, "--json"], bridge);
	assertOk(result, "list-dives --json failed");
	const output = JSON.parse(result.stdout);
	assert.equal(output.pending[0].source, `kb/${diveId}.md`);
	assert.deepEqual(output.pending[0].scopes, [
		"019f8584-453f-79ea-9d53-5f1b20b4cda7 path=docs/api",
	]);
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

	const result = run(["list-dives", effortId], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, new RegExp(`kb/${effortId}\\.md`));
	assert.doesNotMatch(result.stderr, /\\/);
});
