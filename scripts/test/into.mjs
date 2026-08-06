import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

function heldBridge(name, diver) {
	const bridge = join(tmp, name);
	const diveId = "019fcf20-0000-7000-8000-000000000002";
	const backlogId = "019fcf20-0000-7000-8000-000000000001";
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Into Test"], bridge);
	runTool("git", ["config", "user.email", "into@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: backlogId });
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---
kind: memo
id: ${backlogId}
name: backlog.into-test
---

# Backlog
`,
	);
	write(
		join(bridge, "kb", `${diveId}.md`),
		`---
kind: dive
id: ${diveId}
name: held.into-test
gist: "Held test dive"
meta:
  diver: ${diver ?? "null"}
links:
  - kb/019fcf20-0000-7000-8000-000000000003.md:
      rel: patch
---
`,
	);
	writeFileSync(join(bridge, "workspace", ".nosedive-ref"), `id: ${diveId}\n`);
	return { bridge, diveId };
}

test("into distinguishes own, foreign, and unheld marked dives", () => {
	const own = heldBridge("own", "into@example.test");
	const ownResult = run(["into"], own.bridge);
	assert.notEqual(ownResult.status, 0);
	assert.match(ownResult.stderr, /pack, bail, or land/);

	const foreign = heldBridge("foreign", "other@example.test");
	const foreignResult = run(["into"], foreign.bridge);
	assert.notEqual(foreignResult.status, 0);
	assert.match(foreignResult.stderr, /held by other@example\.test/);
	assert.match(foreignResult.stderr, new RegExp(`--ref ${foreign.diveId} --takeover`));

	const free = heldBridge("free", undefined);
	const freeResult = run(["into"], free.bridge);
	assert.equal(freeResult.status, 0, freeResult.stderr);
	assert.match(freeResult.stdout, new RegExp(`unheld marked dive ${free.diveId}`));
	assert.match(freeResult.stdout, /Held test dive.*1 patch chain/);
	assert.match(freeResult.stdout, new RegExp(`record\.dive --ref ${free.diveId}`));
});
