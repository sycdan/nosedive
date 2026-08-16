import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, run, runTool, write, writeBridgeConfig } from "../test-helpers.mjs";

const tmp = createTmp("plan");

function planningBridge(name = "bridge") {
	const bridge = join(tmp, name);
	const backlogId = "01a00bec-0000-7000-8000-000000000001";
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Plan Test"], bridge);
	runTool("git", ["config", "user.email", "plan@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: backlogId });
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---
kind: memo
id: ${backlogId}
name: backlog.plan-test
gist: "Plan test backlog"
---

# Backlog

- Plan this feat.
`,
	);
	return bridge;
}

test("plan shapes a feat into gated vertical half-day dives without starting them", () => {
	const result = run(["plan", "improve handoff"], planningBridge());
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /nosedive-pilot-email: plan@example\.test/);
	assert.match(result.stdout, /Plan this feat\./);
	assert.match(result.stdout, /improve handoff/);
	assert.match(result.stdout, /help the pilot choose (?:which|a) feat/i);
	assert.match(result.stdout, /vertical slices/i);
	assert.match(result.stdout, /logical seams/i);
	assert.match(result.stdout, /no more than half a day/i);
	assert.match(result.stdout, /planner's perspective/i);
	assert.match(result.stdout, /record\.dive/);
	assert.match(result.stdout, /rel: land\.gate/);
	assert.match(result.stdout, /failing test/i);
	assert.match(result.stdout, /must pass/i);
	assert.match(result.stdout, /Stop once .*planned/i);
	assert.doesNotMatch(result.stdout, /Then run .*jump/i);
});
