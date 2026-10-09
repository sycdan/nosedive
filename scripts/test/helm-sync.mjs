import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, libUrl, runTool, seededBridge } from "../test-helpers.mjs";

const { assertBridgeInStep, branchWorktree, helmLogPath, helmPull, helmPush } = await import(
	libUrl
);
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

const todaysLog = (dir) => readFileSync(helmLogPath(dir, new Date()), "utf8");

function refused(fn, status, pattern, message) {
	assert.throws(fn, (err) => err.status === status && pattern.test(err.message), message);
}

test("pull brings trunk into the branch, and push lands it on the branch alone", () => {
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
	assert.match(
		todaysLog(branch),
		/\[no dive\] nosedive pull\n[\s\S]*?\n\[exit 0\]\n/,
		"the pull is logged, ending [exit 0]",
	);

	const out = helmPush(branch);
	assert.equal(typeof out.output, "string");
	const head = git(["rev-parse", "HEAD"], branch);
	assert.equal(git(["rev-parse", "sandbox"], origin), head, "origin/sandbox updated under lease");
	assert.equal(
		git(["rev-parse", "main"], origin),
		theirs,
		"origin/main untouched by a branch push",
	);
});

test("push on trunk fast-forwards origin/main", () => {
	const { bridge, origin } = sandbox("sync-trunk");
	const mine = commit(bridge, "mine.txt", "mine\n", "trunk work");

	helmPush(bridge);
	assert.equal(git(["rev-parse", "main"], origin), mine, "origin/main fast-forwarded");
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

test("push on trunk is refused while origin/main has a commit the checkout lacks", () => {
	const { bridge, origin, branch } = sandbox("sync-behind");
	// The branch worktree stands in for another clone pushing to trunk.
	const theirs = commit(branch, "theirs.txt", "theirs\n", "trunk work elsewhere");
	git(["push", "-q", "origin", "HEAD:main"], branch);
	commit(bridge, "mine.txt", "mine\n", "trunk work");

	refused(() => helmPush(bridge), 409, /pull first/, "push asks for a pull first");
	assert.match(
		todaysLog(bridge),
		/nosedive push\n\norigin\/main has commits this checkout lacks; pull first, then push\n\[exit 1\]\n/,
		"the refused push is logged with its message, ending [exit 1]",
	);
	assert.equal(git(["rev-parse", "main"], origin), theirs, "origin/main untouched");
});

test("pull on a branch with pushed commits leaves origin/<branch> at HEAD", () => {
	const { bridge, origin, branch } = sandbox("sync-pull-push");
	commit(branch, "mine.txt", "mine\n", "branch work");
	git(["push", "-q", "origin", "sandbox"], branch);
	commit(bridge, "theirs.txt", "theirs\n", "trunk work");
	git(["push", "-q", "origin", "HEAD:main"], bridge);

	const out = helmPull(branch);
	assert.match(out.output, /origin\/sandbox/);
	assert.equal(git(["rev-parse", "sandbox"], origin), git(["rev-parse", "HEAD"], branch));
	assert.doesNotThrow(() => assertBridgeInStep(branch), "the dive verbs can run straight away");
});

test("pull on trunk pushes nothing", () => {
	const { bridge, origin } = sandbox("sync-pull-trunk");
	const main = git(["rev-parse", "main"], origin);
	commit(bridge, "mine.txt", "mine\n", "trunk work");

	helmPull(bridge);
	assert.equal(git(["rev-parse", "main"], origin), main, "origin/main untouched");
});

test("assertBridgeInStep refuses only a diverged bridge", () => {
	const { branch } = sandbox("sync-in-step");
	commit(branch, "a.txt", "a\n", "pushed");
	git(["push", "-q", "origin", "sandbox"], branch);

	commit(branch, "b.txt", "b\n", "ahead");
	assert.doesNotThrow(() => assertBridgeInStep(branch), "ahead is fine");
	git(["reset", "-q", "--hard", "HEAD~2"], branch);
	assert.doesNotThrow(() => assertBridgeInStep(branch), "behind is fine");

	commit(branch, "c.txt", "c\n", "elsewhere");
	assert.throws(
		() => assertBridgeInStep(branch),
		/^Error: bridge sandbox has diverged from origin\/sandbox; push it \(helm's Push\) or pull first, then retry$/,
	);
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
