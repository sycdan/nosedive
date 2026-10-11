import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import { createTmp, libUrl, runTool, seededBridge } from "../test-helpers.mjs";

const { branchWorktree, helmBranches, helmDeleteBranch, helmLogPath, helmMerge } = await import(
	libUrl
);
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

test("branches is read-only off trunk; merge refuses off trunk and an unknown branch", () => {
	const { bridge, branch } = published("branches-refused");
	const info = helmBranches(branch);
	assert.equal(info.onTrunk, false);
	assert.equal(info.branches[0].ahead, 1, "compared to trunk, not the branch HEAD");
	refused(() => helmMerge(branch, "sandbox"), 409, /off main/, "merge waits for trunk");
	refused(() => helmMerge(bridge, "nope; rm -rf"), 400, /no fetched origin branch/, "unknown");
});

test("delete on trunk removes the remote branch and its clean helm worktree, leaving trunk intact", () => {
	const { bridge, origin, branch } = published("branches-delete");
	helmBranches(bridge);
	const main = git(["rev-parse", "main"], origin);
	const result = helmDeleteBranch(bridge, "sandbox");
	assert.match(result.output, /removed clean worktree/);
	assert.match(result.output, /stop any helm/);
	assert.equal(existsSync(branch), false);
	assert.equal(git(["branch", "--list", "sandbox"], bridge), "");
	assert.equal(git(["branch", "--list", "sandbox"], origin), "");
	assert.equal(git(["branch", "-r", "--list", "origin/sandbox"], bridge), "");
	assert.equal(git(["rev-parse", "main"], origin), main);
	assert.equal(git(["rev-parse", "HEAD"], bridge), main);
});

test("delete refuses off trunk, trunk itself, and a branch outside the fetched list", () => {
	const { bridge, origin, branch } = published("branches-delete-refused");
	refused(() => helmDeleteBranch(branch, "sandbox"), 409, /off main/, "off trunk");
	refused(() => helmDeleteBranch(bridge, "main"), 400, /cannot delete trunk/, "trunk");
	git(["branch", "unfetched", "main"], origin);
	refused(
		() => helmDeleteBranch(bridge, "unfetched"),
		400,
		/no fetched origin branch/,
		"not fetched",
	);
	refused(() => helmDeleteBranch(bridge, "--all"), 400, /no fetched origin branch/, "git option");
	assert.ok(git(["branch", "--list", "sandbox"], origin));
	assert.ok(existsSync(branch));
});

test("delete keeps a dirty worktree and its local branch, including untracked changes", () => {
	const { bridge, origin, branch } = published("branches-delete-dirty");
	writeFileSync(join(branch, "untracked.txt"), "keep me\n");
	const result = helmDeleteBranch(bridge, "sandbox");
	assert.match(result.output, /kept .*worktree is dirty/);
	assert.match(result.output, /stop any helm/);
	assert.equal(readFileSync(join(branch, "untracked.txt"), "utf8"), "keep me\n");
	assert.ok(git(["branch", "--list", "sandbox"], bridge));
	assert.equal(git(["branch", "--list", "sandbox"], origin), "");
});

test("delete finds helm's flattened worktree path for a slash branch", () => {
	const { bridge, origin } = seededBridge(tmp, "branches-delete-slash", "pilot@nosedive.invalid");
	const branch = branchWorktree(bridge, "work/cleanup", "main", io);
	const result = helmDeleteBranch(bridge, "work/cleanup");
	assert.match(result.output, /removed clean worktree/);
	assert.equal(existsSync(branch), false);
	assert.equal(git(["branch", "--list", "work/cleanup"], origin), "");
});

test("delete confirmation requires an exact branch name, including when submit is triggered directly", () => {
	const source = readFileSync(new URL("../../src/lib/helmDiveUi.ts", import.meta.url), "utf8");
	const nodes = [];
	const el = (tag, attrs, ...children) => {
		const node = {
			tag,
			attrs,
			children,
			value: "",
			disabled: attrs.disabled != null,
			events: {},
			addEventListener(name, handler) {
				this.events[name] = handler;
			},
			focus() {},
			close() {},
			showModal() {},
			remove() {},
		};
		nodes.push(node);
		return node;
	};
	const context = { el, document: { body: { append() {} } } };
	runInNewContext(
		source.slice(source.indexOf("function confirmDialog("), source.indexOf("/** Staging")),
		context,
	);
	let calls = 0;
	context.confirmDialog({
		verb: "Delete",
		cls: "bail",
		target: "work/test from origin",
		detail: "one commit lost",
		requiredText: "work/test",
		act() {
			calls++;
		},
	});
	const input = nodes.find((n) => n.tag === "input");
	const confirm = nodes.find((n) => n.attrs.type === "submit");
	const form = nodes.find((n) => n.tag === "form");
	assert.equal(confirm.disabled, true);
	for (const name of ["", "work", "WORK/test", " work/test "]) {
		input.value = name;
		input.events.input();
		assert.equal(confirm.disabled, true);
		form.events.submit({ preventDefault() {} });
		assert.equal(calls, 0);
	}
	input.value = "work/test";
	input.events.input();
	assert.equal(confirm.disabled, false);
	form.events.submit({ preventDefault() {} });
	assert.equal(calls, 1);
});
