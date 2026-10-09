import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, libUrl, runTool, seededBridge } from "../test-helpers.mjs";

const { branchWorktree, helmBranches, helmLogPath, helmMerge } = await import(libUrl);
const tmp = createTmp("helm-branches");
const io = { log() {} };
const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

function commit(dir, file, text, message) {
	writeFileSync(join(dir, file), text);
	git(["add", file], dir);
	git(["commit", "-q", "-m", message], dir);
	return git(["rev-parse", "HEAD"], dir);
}

function sandbox(name) {
	const { bridge, origin } = seededBridge(tmp, name, "pilot@nosedive.invalid");
	return { bridge, origin, branch: branchWorktree(bridge, "sandbox", "main", io) };
}

/** A sandbox whose branch has one pushed commit. */
function published(name) {
	const box = sandbox(name);
	box.tip = commit(box.branch, "mine.txt", "mine\n", "branch work");
	git(["push", "-q", "origin", "sandbox"], box.branch);
	return box;
}

function refused(fn, status, pattern, message) {
	assert.throws(fn, (err) => err.status === status && pattern.test(err.message), message);
}

test("branches lists a pushed branch against the local trunk, without trunk", () => {
	const { bridge } = published("branches-list");
	const { trunk, branches } = helmBranches(bridge);
	assert.equal(trunk, "main");
	assert.deepEqual(
		branches.map((b) => b.name),
		["sandbox"],
		"trunk is not listed",
	);
	const [b] = branches;
	assert.equal(b.ahead, 1);
	assert.equal(b.behind, 0);
	assert.equal(b.mergeable, true);
	assert.deepEqual(
		b.commits.map((c) => c.subject),
		["branch work"],
	);
});

test("merge fast-forwards the local trunk, pushes nothing, and is logged", () => {
	const { bridge, origin, tip } = published("branches-merge");
	const originMain = git(["rev-parse", "main"], origin);

	const out = helmMerge(bridge, "sandbox");
	assert.match(out.output, /Push publishes it/);
	assert.equal(git(["rev-parse", "HEAD"], bridge), tip, "local trunk at the branch tip");
	assert.equal(git(["rev-parse", "main"], origin), originMain, "origin/main untouched");
	assert.match(
		readFileSync(helmLogPath(bridge, new Date()), "utf8"),
		/nosedive merge sandbox\n[\s\S]*?\n\[exit 0\]\n/,
		"the merge is logged, ending [exit 0]",
	);
});

test("a branch behind a trunk that moved on is not mergeable, and merge is refused", () => {
	const { bridge } = published("branches-behind");
	const mine = commit(bridge, "trunk.txt", "trunk\n", "trunk work");

	const [b] = helmBranches(bridge).branches;
	assert.equal(b.behind, 1);
	assert.equal(b.mergeable, false);
	refused(() => helmMerge(bridge, "sandbox"), 409, /Pull in sandbox/, "merge asks for a pull");
	assert.equal(git(["rev-parse", "HEAD"], bridge), mine, "HEAD unchanged");
});

test("branches and merge are refused off trunk, and merge of an unknown branch", () => {
	const { bridge, branch } = published("branches-refused");
	refused(() => helmBranches(branch), 409, /off main/, "branches waits for trunk");
	refused(() => helmMerge(branch, "sandbox"), 409, /off main/, "merge waits for trunk");
	refused(() => helmMerge(bridge, "nope; rm -rf"), 400, /no fetched origin branch/, "unknown");
});
