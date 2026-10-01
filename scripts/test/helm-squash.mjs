import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, libUrl, runTool, seededBridge } from "../test-helpers.mjs";

const { branchWorktree, helmLogPath, helmSquash, helmUnpushed } = await import(libUrl);
const tmp = createTmp("helm-squash");
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

const todaysLog = (dir) => readFileSync(helmLogPath(dir, new Date()), "utf8");
const ahead = (dir) => git(["rev-list", "origin/main..HEAD"], dir).split("\n").filter(Boolean);

function refused(fn, status, pattern, message) {
	assert.throws(fn, (err) => err.status === status && pattern.test(err.message), message);
}

test("squash on a branch makes its commits one and pushes nothing", () => {
	const { origin, branch } = sandbox("squash-branch");
	commit(branch, "a.txt", "a\n", "first");
	commit(branch, "b.txt", "b\n", "second");
	commit(branch, "c.txt", "c\n", "third");
	const tree = git(["rev-parse", "HEAD^{tree}"], branch);
	const main = git(["rev-parse", "main"], origin);
	const sandboxTip = git(["rev-parse", "sandbox"], origin);

	const info = helmUnpushed(branch);
	assert.deepEqual(
		info.commits.map((c) => c.subject),
		["third", "second", "first"],
		"newest first",
	);
	assert.equal(info.squashable, true);
	assert.equal(info.blocker, null);

	const out = helmSquash(branch, "one\n\nbody");
	assert.match(out.output, /3 commits became one/);
	assert.match(out.output, /force-updat\w+ origin\/sandbox/);
	assert.equal(ahead(branch).length, 1, "one commit over origin/main");
	assert.equal(git(["log", "-1", "--format=%B"], branch), "one\n\nbody");
	assert.equal(git(["rev-parse", "HEAD^{tree}"], branch), tree, "same tree");
	assert.equal(git(["rev-parse", "main"], origin), main, "origin/main unchanged");
	assert.equal(git(["rev-parse", "sandbox"], origin), sandboxTip, "origin/sandbox unchanged");
	assert.match(
		todaysLog(branch),
		/nosedive squash\n[\s\S]*?\n\[exit 0\]\n/,
		"the squash is logged, ending [exit 0]",
	);
});

test("squash refusals leave HEAD as it was", () => {
	const { bridge, branch } = sandbox("squash-refuse");
	commit(branch, "a.txt", "a\n", "first");
	let head = git(["rev-parse", "HEAD"], branch);
	refused(() => helmSquash(branch, "msg"), 409, /nothing to squash/, "one commit");
	assert.equal(helmUnpushed(branch).blocker, "Nothing to squash.");
	assert.equal(git(["rev-parse", "HEAD"], branch), head);

	head = commit(branch, "b.txt", "b\n", "second");
	refused(() => helmSquash(branch, "  \n "), 400, /message/, "empty message");
	assert.equal(git(["rev-parse", "HEAD"], branch), head);

	writeFileSync(join(branch, "a.txt"), "dirty\n");
	refused(() => helmSquash(branch, "msg"), 409, /uncommitted changes/, "dirty tree");
	assert.equal(git(["rev-parse", "HEAD"], branch), head);
	git(["checkout", "--", "a.txt"], branch);

	commit(bridge, "theirs.txt", "theirs\n", "trunk work");
	git(["push", "-q", "origin", "HEAD:main"], bridge);
	refused(() => helmSquash(branch, "msg"), 409, /pull first/, "behind origin/main");
	assert.equal(git(["rev-parse", "HEAD"], branch), head);
	const behind = helmUnpushed(branch);
	assert.equal(behind.squashable, false);
	assert.equal(behind.blocker, "Pull first: origin/main has 1 commit this checkout lacks.");
});

test("squash waits for an active dive, though the read still answers", () => {
	const { branch } = sandbox("squash-dive");
	commit(branch, "a.txt", "a\n", "first");
	const head = commit(branch, "b.txt", "b\n", "second");
	mkdirSync(join(branch, "workspace"), { recursive: true });
	writeFileSync(
		join(branch, "workspace", ".nosedive-ref"),
		"id: 0b5e7a3c-1d2e-4f60-8a9b-0c1d2e3f4a5b\n",
	);

	refused(() => helmSquash(branch, "msg"), 409, /dive is active/, "squash waits for the dive");
	assert.equal(git(["rev-parse", "HEAD"], branch), head);
	const info = helmUnpushed(branch);
	assert.equal(info.commits.length, 2);
	assert.equal(info.squashable, false);
	assert.match(info.blocker, /dive/);
});

test("squash on trunk leaves origin/main alone", () => {
	const { bridge, origin } = sandbox("squash-trunk");
	const main = git(["rev-parse", "main"], origin);
	commit(bridge, "a.txt", "a\n", "first");
	commit(bridge, "b.txt", "b\n", "second");

	const out = helmSquash(bridge, "both");
	assert.doesNotMatch(out.output, /force/);
	assert.equal(ahead(bridge).length, 1);
	assert.equal(git(["log", "-1", "--format=%s"], bridge), "both");
	assert.equal(git(["rev-parse", "main"], origin), main, "origin/main unchanged");
});
