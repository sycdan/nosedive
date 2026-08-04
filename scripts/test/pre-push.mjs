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

const ZERO_SHA = "0".repeat(40);
const tmp = createTmp("pre-push");

function commit(bridge, path, content, message) {
	write(join(bridge, path), content);
	runTool("git", ["add", "--force", path], bridge);
	gitCommit(bridge, message);
	return runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();
}

function updateLine(localSha, remoteSha) {
	return `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`;
}

test("pre-push rejects pushed commits touching the configured workspace", () => {
	const bridge = join(tmp, "bridge");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	writeBridgeConfig(bridge, { workspace: "./work-area" });

	const base = commit(bridge, "kb/base.md", "base\n", "base");
	const allowed = commit(bridge, "kb/allowed.md", "allowed\n", "allowed");
	assertOk(
		run(["_pre-push.hook", "origin", "unused"], bridge, updateLine(allowed, base)),
		"a pushed commit outside workspace should pass",
	);

	const blocked = commit(bridge, "work-area/blocked.txt", "blocked\n", "blocked");
	const rejection = run(
		["_pre-push.hook", "origin", "unused"],
		bridge,
		updateLine(blocked, allowed),
	);
	assert.equal(rejection.status, 1);
	assert.match(rejection.stderr, /push rejected/);
	assert.match(rejection.stderr, /work-area/);
	assert.match(rejection.stderr, /dist\/cli\.js render 9e3a676a-6d2f-5b93-93af-f4608ed28843/);

	const later = commit(bridge, "kb/later.md", "later\n", "later");
	const cumulativeRejection = run(["_pre-push.hook"], bridge, updateLine(later, allowed));
	assert.equal(
		cumulativeRejection.status,
		1,
		"the hook must inspect every commit in the push range",
	);

	const newBranchRejection = run(["_pre-push.hook"], bridge, updateLine(later, ZERO_SHA));
	assert.equal(newBranchRejection.status, 1, "new branches must inspect their reachable history");

	assertOk(run(["_pre-push.hook"], bridge, ""), "an empty ref update should pass");
});
