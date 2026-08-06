import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	run,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("bail");

test("bail commits effort and nosedive provenance", () => {
	const origin = join(tmp, "origin.git");
	const bridge = join(tmp, "bridge");
	const effortId = "019fcf20-0000-7000-8000-000000000001";
	mkdirSync(origin, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], origin);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Bail Test"], bridge);
	runTool("git", ["config", "user.email", "bail@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: effort
id: ${effortId}
name: bail-test.nosedive
gist: "Bail test effort"
---
`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "initial bridge state");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	const dive = run(["record.dive", "--effort", effortId, "--diver", "bail@example.test"], bridge);
	assertOk(dive, "record.dive failed");
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "record dive");
	const result = run(["bail", "testing"], bridge);
	assertOk(result, "bail failed");
	const commitBody = runTool("git", ["log", "-1", "--format=%B"], bridge).stdout;
	assert.match(commitBody, new RegExp(`Effort: ${effortId}`));
	assert.match(commitBody, /Co-Authored-By: nosedive@0\.0\.0-dev <noreply@nosedive\.dev>/);
	assert.equal((commitBody.match(/Co-Authored-By: nosedive@/g) ?? []).length, 1);
});
