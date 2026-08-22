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
	assert.match(rejection.stderr, /^nosedive: push rejected/m);
	assert.match(rejection.stderr, /work-area\/blocked\.txt/);
	assert.match(rejection.stderr, /git rm -r --cached work-area\/blocked\.txt/);
	assert.match(rejection.stderr, /see kb\/019fce99-1d6e-7fa4-aa0c-a548d7049643\.md for why/);

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

test("pre-push ignores workspace commits a remote already holds", () => {
	const bridge = join(tmp, "already-pushed");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	writeBridgeConfig(bridge, { workspace: "./work-area" });

	commit(bridge, "kb/base.md", "base\n", "base");
	const pushed = commit(bridge, "work-area/history.txt", "history\n", "history");
	// The state every fetched clone is in. Without a remote sha to bound the range,
	// a new branch reaches this commit and every other one before it.
	runTool("git", ["update-ref", "refs/remotes/origin/main", pushed], bridge);

	const clean = commit(bridge, "kb/topic.md", "topic\n", "topic");
	assertOk(
		run(["_pre-push.hook"], bridge, updateLine(clean, ZERO_SHA)),
		"a new branch adding no workspace commit should pass",
	);

	const added = commit(bridge, "work-area/added.txt", "added\n", "added");
	const rejection = run(["_pre-push.hook"], bridge, updateLine(added, ZERO_SHA));
	assert.equal(rejection.status, 1, "a workspace commit no remote holds must still be rejected");
});
