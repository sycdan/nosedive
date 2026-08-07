import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	packageVersionPattern,
	run,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("pack");

function bareRemote(name) {
	const path = join(tmp, name);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], path);
	return path;
}

function sourceRepo(name) {
	const path = join(tmp, name);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "-b", "main"], path);
	write(join(path, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], path);
	gitCommit(path, "base");
	return path;
}

function setup(name) {
	const origin = bareRemote(`${name}-origin.git`);
	const source = sourceRepo(`${name}-source`);
	const bridge = join(tmp, name);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Pack Test"], bridge);
	runTool("git", ["config", "user.email", "pack@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });

	const repoId = "019fcf00-0000-7000-8000-000000000001";
	const effortId = "019fcf00-0000-7000-8000-000000000002";
	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: ${name}-repo
gist: "Pack test scoped repo"
meta:
  path: workspace/${name}-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
---
`,
	);
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: pack-test.nosedive
gist: "Pack test effort"
scopes:
  - ${repoId}
---

# Pack Test
`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "initial bridge state");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate scoped repo failed");
	const diveResult = run(
		["record.dive", "--effort", effortId, "--diver", "pack@example.test"],
		bridge,
	);
	assertOk(diveResult, "record.dive failed");
	const diveId = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(diveResult.stdout)?.[1];
	assert.ok(diveId, `record.dive did not report a dive id:\n${diveResult.stdout}`);
	// record.dive also writes the effort's reciprocal link; on a real bridge jump
	// commits both, so start from that state rather than pre-loading bridge WIP.
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "record dive");

	return { bridge, origin, source, repoId, effortId, diveId };
}

function repoWorktree(bridge, name) {
	return join(bridge, "workspace", `${name}-repo`);
}

function splitDoc(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	assert.ok(match, `expected frontmatter in:\n${text}`);
	return { yaml: match[1], body: text.slice(match[0].length) };
}

function readMemo(bridge, relPath) {
	const text = readFileSync(join(bridge, relPath), "utf8");
	const { yaml, body } = splitDoc(text);
	return {
		kind: /^kind: (.+)$/m.exec(yaml)?.[1],
		id: /^id: (.+)$/m.exec(yaml)?.[1],
		name: /^name: (.+)$/m.exec(yaml)?.[1],
		gist: (/^gist: "(.*)"$/m.exec(yaml) ?? /^gist: (.+)$/m.exec(yaml))?.[1],
		patch: /^ {2}patch: (.+)$/m.exec(yaml)?.[1],
		next: /- (kb\/[0-9a-f-]{36}\.md):\n\s+rel: next/.exec(yaml)?.[1],
		body: body.trim(),
	};
}

function patchHeadsByRel(diveText, rel) {
	return [
		...diveText.matchAll(new RegExp(`- (kb\\/[0-9a-f-]{36}\\.md):\\n\\s+rel: ${rel}`, "g")),
	].map((match) => match[1]);
}

test("pack requires an active dive marker", () => {
	const bridge = join(tmp, "no-marker");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	const result = run(["pack"], bridge);
	assert.notEqual(result.status, 0, "pack without a dive marker unexpectedly succeeded");
	assert.match(result.stderr, /pack requires an active dive marker/);
});

test("pack captures ahead commits, dirty state, bridge-wip, pushes, and resets", () => {
	const { bridge, origin, repoId, effortId, diveId } = setup("full");
	const worktree = repoWorktree(bridge, "full");

	write(join(worktree, "feature-a.txt"), "a\n");
	runTool("git", ["add", "feature-a.txt"], worktree);
	gitCommit(worktree, "add feature a");
	write(join(worktree, "feature-b.txt"), "b\n");
	runTool("git", ["add", "feature-b.txt"], worktree);
	gitCommit(worktree, "add feature b");

	write(join(worktree, "README.md"), "base\nedited\n");
	write(join(worktree, "untracked.txt"), "untracked\n");

	const effortPath = join(bridge, "kb", `${effortId}.md`);
	write(effortPath, `${readFileSync(effortPath, "utf8")}\nExtra bridge WIP line.\n`);

	const stray = join(bridge, "stray.txt");
	write(stray, "unrelated bridge dirty file\n");

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: 4 artifact\\(s\\)`));
	assert.match(
		result.stdout,
		new RegExp(`reset repo=${repoId} path=workspace/full-repo ref=[0-9a-f]{40}`),
	);
	assert.equal(existsSync(worktree), true, "scoped repo should remain hydrated after pack");
	const pin = /^\s+ref: ([0-9a-f]{40})$/m.exec(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
	)?.[1];
	assert.ok(pin, "dive should retain a scope pin");
	assert.equal(runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim(), pin);
	assert.equal(runTool("git", ["status", "--porcelain"], worktree).stdout, "");
	assert.equal(existsSync(join(worktree, ".nosedive-ref")), true, "managed marker should remain");

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.match(diveText, /^  diver: null$/m, "pack should release the dive");
	assert.match(
		readFileSync(join(bridge, "kb", `${effortId}.md`), "utf8"),
		new RegExp(`- kb/${diveId}\\.md:\\n      rel: pending`),
	);
	const patchHeads = patchHeadsByRel(diveText, "patch");
	assert.equal(patchHeads.length, 2, `expected 2 patch chain heads:\n${diveText}`);

	// Walk the repo chain from its head via `rel: next` -- order is the chain, not array position.
	const repoChainHead = patchHeads.find((head) =>
		readMemo(bridge, head).name.endsWith("full-repo"),
	);
	assert.ok(repoChainHead, `expected a repo patch chain head:\n${diveText}`);
	const commitA = readMemo(bridge, repoChainHead);
	assert.equal(commitA.kind, "memo");
	assert.match(commitA.name, /^[0-9a-f]{12}\.full-repo$/);
	assert.equal(commitA.gist, "add feature a");
	assert.equal(commitA.body, "");
	assert.ok(commitA.next, "commit A memo should link the next memo");

	const commitB = readMemo(bridge, commitA.next);
	assert.match(commitB.name, /^[0-9a-f]{12}\.full-repo$/);
	assert.equal(commitB.gist, "add feature b");
	assert.ok(commitB.next, "commit B memo should link the next memo");

	const dirty = readMemo(bridge, commitB.next);
	assert.equal(dirty.name, "dirty.full-repo");
	assert.equal(dirty.gist, "Uncommitted working-tree changes.");
	assert.equal(dirty.next, undefined, "dirty memo should be the end of the chain");

	const bridgeWipHead = patchHeads.find((head) => head !== repoChainHead);
	const bridgeWip = readMemo(bridge, bridgeWipHead);
	assert.match(bridgeWip.name, /^bridge-wip\.[0-9a-f]{6}$/);
	assert.equal(bridgeWip.gist, "Uncommitted bridge kb/ changes.");
	assert.equal(bridgeWip.next, undefined);

	const commitAPatch = readFileSync(join(bridge, commitA.patch), "utf8");
	assert.match(commitAPatch, /Subject: \[PATCH\] add feature a/);
	assert.match(commitAPatch, /\+a/);
	// `gitRun` trims stdout; a captured patch went through that for a while,
	// silently stripping the trailing newline `format-patch` always ends
	// with (and, worse, a trailing whitespace-only context line when one
	// exists) -- both make `git am`/`git apply` reject the patch as corrupt.
	assert.match(commitAPatch, /\n$/, "captured commit patch must keep its trailing newline");

	const dirtyPatch = readFileSync(join(bridge, dirty.patch), "utf8");
	assert.match(dirtyPatch, /\+edited/);
	assert.match(dirtyPatch, /untracked\.txt/);
	assert.match(dirtyPatch, /\n$/, "captured dirty diff must keep its trailing newline");

	const bridgeWipPatch = readFileSync(join(bridge, bridgeWip.patch), "utf8");
	assert.match(bridgeWipPatch, /Extra bridge WIP line\./);
	assert.match(bridgeWipPatch, /\n$/, "captured bridge-wip diff must keep its trailing newline");

	const log = runTool("git", ["log", "-1", "--format=%s"], bridge).stdout.trim();
	assert.equal(log, `dive(${diveText.match(/^name: (.+)$/m)[1]}): packed wip`);
	const commitBody = runTool("git", ["log", "-1", "--format=%B"], bridge).stdout;
	assert.match(commitBody, new RegExp(`Effort: ${effortId}`));
	assert.match(
		commitBody,
		new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern} <noreply@nosedive\\.dev>`),
	);
	assert.equal((commitBody.match(/Co-Authored-By: nosedive /g) ?? []).length, 1);

	const bridgeHead = runTool("git", ["rev-parse", "main"], bridge).stdout.trim();
	const originHead = runTool("git", ["rev-parse", "main"], origin).stdout.trim();
	assert.equal(bridgeHead, originHead, "pack should push the bridge to its remote");

	const strayStatus = runTool("git", ["status", "--porcelain", "--", "stray.txt"], bridge).stdout;
	assert.match(
		strayStatus,
		/^\?\? stray\.txt/m,
		"unrelated dirty file should be restored, not committed",
	);
	assert.equal(readFileSync(stray, "utf8"), "unrelated bridge dirty file\n");
});

test("a packed dive reaches jump and reapplies its patch chain", () => {
	const { bridge, diveId } = setup("resume");
	const worktree = repoWorktree(bridge, "resume");
	assertOk(run(["record.dive", "--ref", diveId, "--brief", "Resume packed work."], bridge));
	write(join(worktree, "resumed.txt"), "resumed\n");
	runTool("git", ["add", "resumed.txt"], worktree);
	gitCommit(worktree, "resume me");
	assertOk(run(["pack"], bridge), "pack failed");
	assertOk(run(["jump"], bridge), "jump failed after pack");
	assert.equal(readFileSync(join(worktree, "resumed.txt"), "utf8"), "resumed\n");
	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.doesNotMatch(diveText, /rel: patch/);
});

test("pack refuses a read-only scope with unpacked work", () => {
	const { bridge, effortId, diveId } = setup("readonly");
	const roRepoId = "019fcf00-0000-7000-8000-000000000003";
	const source = sourceRepo("readonly-ro-source");
	write(
		join(bridge, "kb", `${roRepoId}.md`),
		`---
kind: repo
id: ${roRepoId}
name: readonly-ro-repo
gist: "Read-only pack test repo"
meta:
  path: workspace/readonly-ro-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
---
`,
	);
	assertOk(
		run(["hydrate-repo.workspace", roRepoId, "--read-only"], bridge),
		"hydrate read-only repo failed",
	);
	assertOk(
		run(["record.dive", "--ref", diveId, "--scope", roRepoId], bridge),
		"scoping read-only repo onto dive failed",
	);

	const roWorktree = repoWorktree(bridge, "readonly-ro");
	write(join(roWorktree, "dirty.txt"), "dirty\n");

	const result = run(["pack"], bridge);
	assert.notEqual(result.status, 0, "pack over a dirty read-only scope unexpectedly succeeded");
	assert.match(result.stderr, new RegExp(`read-only scoped repo ${roRepoId} has unpacked work`));
	assert.equal(existsSync(roWorktree), true, "read-only scope should be left alone on refusal");
	void effortId;
});

test("pack with nothing to capture still resets and reports no-op", () => {
	const { bridge, repoId, diveId } = setup("clean");
	const worktree = repoWorktree(bridge, "clean");
	const beforeHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed on a clean scope");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: nothing to pack`));
	assert.match(result.stdout, new RegExp(`reset repo=${repoId}`));
	assert.equal(existsSync(worktree), true);
	assert.equal(runTool("git", ["status", "--porcelain"], worktree).stdout, "");
	assert.notEqual(
		runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(),
		beforeHead,
		"releasing a held dive should create a bridge commit",
	);
});

test("pack captures bridge kb/ WIP whose filename needs quoting under plain --porcelain", () => {
	const { bridge, effortId, diveId } = setup("spacey");

	// Plain `git status --porcelain` (no `-z`) C-quotes a path like this by
	// default (`core.quotePath`), which `split(/\r?\n/)` + `slice(3)` cannot
	// undo -- the file would be silently dropped from bridge-wip capture.
	const spaceyPath = join(bridge, "kb", "space name.md");
	write(spaceyPath, "kind: memo\ngist: has a space in its filename\n");

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed to capture a spacey-filename bridge-wip change");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: 1 artifact\\(s\\)`));

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const patchHeads = patchHeadsByRel(diveText, "patch");
	assert.equal(patchHeads.length, 1, `expected 1 patch chain head:\n${diveText}`);

	const bridgeWip = readMemo(bridge, patchHeads[0]);
	assert.match(bridgeWip.name, /^bridge-wip\.[0-9a-f]{6}$/);
	const patchText = readFileSync(join(bridge, bridgeWip.patch), "utf8");
	assert.match(patchText, /space name\.md/);
	assert.match(patchText, /has a space in its filename/);
	void effortId;
});
