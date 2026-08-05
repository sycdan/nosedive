import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, run, runTool, write, writeBridgeConfig } from "../test-helpers.mjs";

const tmp = createTmp("into");

test("into requires a write-once endpoint brief and leaves jump to workon", () => {
	const bridge = join(tmp, "bridge");
	const backlogId = "019fcf20-0000-7000-8000-000000000001";
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Into Test"], bridge);
	runTool("git", ["config", "user.email", "into@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: backlogId });
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---
kind: memo
id: ${backlogId}
name: backlog.into-test
gist: "Into test backlog"
---

# Backlog
`,
	);

	const result = run(["into", "test handoff"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stdout,
		/one small slice, stating where the code is now and what has to be true/,
	);
	assert.match(result.stdout, /preserve its existing `## Brief` section byte-for-byte/);
	assert.match(result.stdout, /Stop once the dive is claimed and briefed/);
	assert.doesNotMatch(result.stdout, /Then run .*jump/);
});
