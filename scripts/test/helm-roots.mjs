import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createTmp, libUrl, run, runTool, seededBridge } from "../test-helpers.mjs";

const { helmAddRoot, helmLogPath, helmMemos, helmRemoveRoot } = await import(libUrl);
const tmp = createTmp("helm-roots");
const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();
const config = (dir) => readFileSync(join(dir, ".nosedive", "config.yaml"), "utf8");
const backlogOf = (dir) => /^backlog: (\S+)$/m.exec(config(dir))[1];
const rootsLine = (dir) => /^roots:.*$/m.exec(config(dir))?.[0];
const todaysLog = (dir) => readFileSync(helmLogPath(dir, new Date()), "utf8");

function sandbox(name) {
	const { bridge, origin } = seededBridge(tmp, name, "pilot@nosedive.invalid");
	return { bridge, origin };
}

function mintMemo(bridge, gist) {
	const minted = run(["crud", "memo", gist], bridge);
	assertOk(minted, "crud memo failed");
	return /Minted \S*?([0-9a-f-]{36})\.md/.exec(minted.stdout)[1];
}

async function refused(promise, status, pattern, message) {
	await assert.rejects(
		promise,
		(err) => err.status === status && pattern.test(err.message),
		message,
	);
}

test("adding an existing memo lists it, commits the config, and pushes nothing", async () => {
	const { bridge, origin } = sandbox("roots-add");
	const memo = mintMemo(bridge, "Second plan");
	assert.ok(helmMemos(bridge).some((m) => m.id === memo));
	const remote = git(["rev-parse", "main"], origin);
	const before = config(bridge);

	const out = await helmAddRoot(bridge, { id: memo });
	assert.equal(out.id, memo);
	assert.equal(rootsLine(bridge), `roots: ${memo}`);
	assert.equal(config(bridge).replace(/^roots:.*\n/m, ""), before, "the rest kept");
	assert.match(git(["log", "-1", "--format=%s"], bridge), /^roots: listed /);
	assert.deepEqual(
		git(["show", "--name-only", "--format=", "HEAD"], bridge),
		".nosedive/config.yaml",
	);
	assert.equal(git(["status", "--porcelain"], bridge), "");
	assert.equal(git(["rev-parse", "main"], origin), remote, "nothing pushed");
	assert.match(
		todaysLog(bridge),
		new RegExp(`nosedive roots add ${memo}\\n[\\s\\S]*?\\[exit 0\\]`),
	);

	const second = mintMemo(bridge, "Third plan");
	await helmAddRoot(bridge, { id: second });
	assert.equal(rootsLine(bridge), `roots: ${memo}, ${second}`, "one comma string");
});

test("the backlog and an already-listed root are not written twice", async () => {
	const { bridge } = sandbox("roots-twice");
	const memo = mintMemo(bridge, "Second plan");
	await helmAddRoot(bridge, { id: memo });
	const head = git(["rev-parse", "HEAD"], bridge);
	assert.match((await helmAddRoot(bridge, { id: memo })).output, /already a root/);
	assert.match((await helmAddRoot(bridge, { id: backlogOf(bridge) })).output, /backlog/);
	assert.equal(rootsLine(bridge), `roots: ${memo}`);
	assert.equal(git(["rev-parse", "HEAD"], bridge), head, "no commit");
});

test("a non-memo is refused", async () => {
	const { bridge } = sandbox("roots-nonmemo");
	const repo = /^bridge: (\S+)$/m.exec(config(bridge))?.[1];
	assert.ok(repo, "the seeded bridge names its repo doc");
	await refused(helmAddRoot(bridge, { id: repo }), 400, /a root is a memo/);
	await refused(helmAddRoot(bridge, { id: "0b5e7a3c-1d2e-4f60-8a9b-0c1d2e3f4a5b" }), 400, /no doc/);
	assert.equal(rootsLine(bridge), undefined);
	assert.match(todaysLog(bridge), /\[exit 1\]/);
});

test("remove unlists, dropping the key when empty; the backlog stays", async () => {
	const { bridge } = sandbox("roots-remove");
	const a = mintMemo(bridge, "Plan a");
	const b = mintMemo(bridge, "Plan b");
	await helmAddRoot(bridge, { id: a });
	await helmAddRoot(bridge, { id: b });
	await helmRemoveRoot(bridge, a);
	assert.equal(rootsLine(bridge), `roots: ${b}`);
	assert.match(git(["log", "-1", "--format=%s"], bridge), /^roots: unlisted /);
	await helmRemoveRoot(bridge, b);
	assert.equal(rootsLine(bridge), undefined, "key dropped");
	assert.ok(
		helmMemos(bridge).some((m) => m.id === b),
		"the memo stays",
	);
	await refused(helmRemoveRoot(bridge, a), 409, /not a listed root/);
	await refused(helmRemoveRoot(bridge, backlogOf(bridge)), 400, /backlog/);
	assert.match(todaysLog(bridge), new RegExp(`nosedive roots remove ${b}\\n`));
});

test("both are refused during a dive", async () => {
	const { bridge } = sandbox("roots-dive");
	const memo = mintMemo(bridge, "Plan");
	await helmAddRoot(bridge, { id: memo });
	const other = mintMemo(bridge, "Other");
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	writeFileSync(
		join(bridge, "workspace", ".nosedive-ref"),
		"id: 0b5e7a3c-1d2e-4f60-8a9b-0c1d2e3f4a5b\n",
	);
	await refused(helmAddRoot(bridge, { id: other }), 409, /dive is active/);
	await refused(helmRemoveRoot(bridge, memo), 409, /dive is active/);
	assert.equal(rootsLine(bridge), `roots: ${memo}`);
});

test("add mints a new memo through crud, then lists it", async () => {
	const { bridge } = sandbox("roots-mint");
	const out = await helmAddRoot(bridge, { name: "side-plan", gist: "A side plan" });
	assert.match(out.output, /Minted/);
	assert.equal(rootsLine(bridge), `roots: ${out.id}`);
	assert.ok(helmMemos(bridge).some((m) => m.id === out.id && m.name === "side-plan"));
	assert.equal(
		git(["log", "-1", "--format=%s"], bridge).startsWith("roots: listed side-plan"),
		true,
	);
	assert.equal(git(["status", "--porcelain"], bridge), "");
	await refused(helmAddRoot(bridge, { name: "side-plan", gist: "Again" }), 400, /taken/);
});
