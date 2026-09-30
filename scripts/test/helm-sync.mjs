import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, libUrl, runTool, seededBridge } from "../test-helpers.mjs";

const { branchWorktree, helmPull, helmPush } = await import(libUrl);
const tmp = createTmp("helm-sync");
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

function refused(fn, status, pattern, message) {
	assert.throws(fn, (err) => err.status === status && pattern.test(err.message), message);
}

test("pull brings trunk into the branch, and push lands it on trunk and the branch", () => {
	const { bridge, origin, branch } = sandbox("sync-flow");
	const mine = commit(branch, "mine.txt", "mine\n", "branch work");
	// Published, so the rebase below takes the branch off origin/sandbox's line.
	git(["push", "-q", "origin", "sandbox"], branch);
	const theirs = commit(bridge, "theirs.txt", "theirs\n", "trunk work");
	git(["push", "-q", "origin", "HEAD:main"], bridge);

	helmPull(branch);
	assert.equal(
		runTool("git", ["merge-base", "--is-ancestor", theirs, "HEAD"], branch).status,
		0,
		"trunk's commit is in the branch",
	);
	assert.equal(readFileSync(join(branch, "theirs.txt"), "utf8"), "theirs\n");
	assert.notEqual(git(["rev-parse", "HEAD"], branch), mine, "the pull rewrote the branch");

	const out = helmPush(branch);
	assert.equal(typeof out.output, "string");
	const head = git(["rev-parse", "HEAD"], branch);
	assert.equal(git(["rev-parse", "main"], origin), head, "origin/main fast-forwarded");
	assert.equal(git(["rev-parse", "sandbox"], origin), head, "origin/sandbox updated under lease");
});

test("a conflicting pull is refused by file and leaves the checkout as it was", () => {
	const { bridge, branch } = sandbox("sync-conflict");
	commit(branch, "clash.txt", "branch\n", "branch side");
	commit(bridge, "clash.txt", "trunk\n", "trunk side");
	git(["push", "-q", "origin", "HEAD:main"], bridge);
	const before = git(["rev-parse", "HEAD"], branch);

	refused(() => helmPull(branch), 409, /clash\.txt/, "the conflict names the file");
	assert.equal(git(["rev-parse", "HEAD"], branch), before, "HEAD unchanged");
	assert.equal(git(["status", "--porcelain"], branch), "", "working tree clean");
	assert.equal(readFileSync(join(branch, "clash.txt"), "utf8"), "branch\n");
});

test("push is refused while origin/main has a commit the branch lacks", () => {
	const { bridge, origin, branch } = sandbox("sync-behind");
	commit(branch, "mine.txt", "mine\n", "branch work");
	const theirs = commit(bridge, "theirs.txt", "theirs\n", "trunk work");
	git(["push", "-q", "origin", "HEAD:main"], bridge);

	refused(() => helmPush(branch), 409, /pull first/, "push asks for a pull first");
	assert.equal(git(["rev-parse", "main"], origin), theirs, "origin/main untouched");
});

test("pull and push are refused while a dive is active", () => {
	const { origin, branch } = sandbox("sync-dive");
	commit(branch, "mine.txt", "mine\n", "branch work");
	const trunk = git(["rev-parse", "main"], origin);
	mkdirSync(join(branch, "workspace"), { recursive: true });
	writeFileSync(
		join(branch, "workspace", ".nosedive-ref"),
		"id: 0b5e7a3c-1d2e-4f60-8a9b-0c1d2e3f4a5b\n",
	);

	refused(() => helmPull(branch), 409, /dive is active/, "pull waits for the dive");
	refused(() => helmPush(branch), 409, /dive is active/, "push waits for the dive");
	assert.equal(git(["rev-parse", "main"], origin), trunk, "origin/main untouched");
});
