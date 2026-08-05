import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const tmp = createTmp("jump");

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
	runTool("git", ["config", "user.name", "Jump Test"], bridge);
	runTool("git", ["config", "user.email", "jump@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });

	const repoId = "019fcf10-0000-7000-8000-000000000001";
	const effortId = "019fcf10-0000-7000-8000-000000000002";
	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: ${name}-repo
gist: "Jump test scoped repo"
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
kind: effort
id: ${effortId}
name: jump-test.nosedive
gist: "Jump test effort"
---

# Jump Test
`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "initial bridge state");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate scoped repo failed");
	const diveResult = run(
		["record.dive", "--effort", effortId, "--diver", "jump@example.test", "--brief", "Test brief."],
		bridge,
	);
	assertOk(diveResult, "record.dive failed");
	const diveId = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(diveResult.stdout)?.[1];
	assert.ok(diveId, `record.dive did not report a dive id:\n${diveResult.stdout}`);

	const pinnedRef = runTool("git", ["rev-parse", "HEAD"], repoWorktree(bridge, name)).stdout.trim();

	return { bridge, origin, source, repoId, effortId, diveId, pinnedRef };
}

function repoWorktree(bridge, name) {
	return join(bridge, "workspace", `${name}-repo`);
}

/**
 * Hand-crafts the patch memo chain `pack` would have produced for two ahead
 * commits plus a trailing dirty diff, then links the chain's head on the dive
 * and force-dehydrates the scope -- `pack` doesn't exist yet at the commit
 * `jump` is being built against, so its output shape is reproduced by hand.
 */
function packByHand(bridge, name, repoId, diveId, pinnedRef) {
	const worktree = repoWorktree(bridge, name);
	const kbDir = join(bridge, "kb");
	const artifactsDir = join(kbDir, "artifacts");
	mkdirSync(artifactsDir, { recursive: true });

	const shas = runTool("git", ["rev-list", "--reverse", `${pinnedRef}..HEAD`], worktree)
		.stdout.trim()
		.split("\n")
		.filter(Boolean);
	assert.equal(shas.length, 2, "expected exactly two ahead commits in the fixture");
	const [shaA, shaB] = shas;

	const patchA = runTool(
		"git",
		["format-patch", "-1", shaA, "--stdout", "--binary", "--no-signature"],
		worktree,
	).stdout;
	const patchB = runTool(
		"git",
		["format-patch", "-1", shaB, "--stdout", "--binary", "--no-signature"],
		worktree,
	).stdout;
	runTool("git", ["add", "--intent-to-add", "--", "untracked.txt"], worktree);
	const dirtyPatch = runTool("git", ["diff", "--binary", "HEAD"], worktree).stdout;
	runTool("git", ["reset", "--", "untracked.txt"], worktree);

	write(join(artifactsDir, "aaaaaaaa-0000-7000-8000-00000000000a.patch"), patchA);
	write(join(artifactsDir, "aaaaaaaa-0000-7000-8000-00000000000b.patch"), patchB);
	write(join(artifactsDir, "aaaaaaaa-0000-7000-8000-00000000000c.patch"), dirtyPatch);

	write(
		join(kbDir, "aaaaaaaa-1000-7000-8000-00000000000a.md"),
		`---
kind: memo
id: aaaaaaaa-1000-7000-8000-00000000000a
name: ${shaA.slice(0, 12)}.${name}-repo
gist: "add feature a"
meta:
  patch: kb/artifacts/aaaaaaaa-0000-7000-8000-00000000000a.patch
links:
  - kb/aaaaaaaa-1000-7000-8000-00000000000b.md:
      rel: next
---

`,
	);
	write(
		join(kbDir, "aaaaaaaa-1000-7000-8000-00000000000b.md"),
		`---
kind: memo
id: aaaaaaaa-1000-7000-8000-00000000000b
name: ${shaB.slice(0, 12)}.${name}-repo
gist: "add feature b"
meta:
  patch: kb/artifacts/aaaaaaaa-0000-7000-8000-00000000000b.patch
links:
  - kb/aaaaaaaa-1000-7000-8000-00000000000c.md:
      rel: next
---

`,
	);
	write(
		join(kbDir, "aaaaaaaa-1000-7000-8000-00000000000c.md"),
		`---
kind: memo
id: aaaaaaaa-1000-7000-8000-00000000000c
name: dirty.${name}-repo
gist: "Uncommitted working-tree changes."
meta:
  patch: kb/artifacts/aaaaaaaa-0000-7000-8000-00000000000c.patch
---

`,
	);

	const divePath = join(kbDir, `${diveId}.md`);
	const diveText = readFileSync(divePath, "utf8");
	writeFileSync(
		divePath,
		diveText.replace(
			/^meta:/m,
			"links:\n  - kb/aaaaaaaa-1000-7000-8000-00000000000a.md:\n      rel: patch\nmeta:",
		),
	);

	assertOk(run(["dehydrate-repo.workspace", repoId, "--force"], bridge), "dehydrate failed");
	runTool("git", ["add", "-A"], bridge);
	gitCommit(bridge, `dive(${diveId}): packed wip`);
	runTool("git", ["push"], bridge);
}

test("jump requires an active dive marker", () => {
	const bridge = join(tmp, "no-marker");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump without a dive marker unexpectedly succeeded");
	assert.match(result.stderr, /jump requires an active dive marker/);
});

test("jump hydrates a packed dive's scoped repos and reapplies every patch chain", () => {
	const { bridge, origin, repoId, diveId, pinnedRef } = setup("full");
	const worktree = repoWorktree(bridge, "full");

	write(join(worktree, "feature-a.txt"), "a\n");
	runTool("git", ["add", "feature-a.txt"], worktree);
	gitCommit(worktree, "add feature a");
	write(join(worktree, "feature-b.txt"), "b\n");
	runTool("git", ["add", "feature-b.txt"], worktree);
	gitCommit(worktree, "add feature b");
	write(join(worktree, "README.md"), "base\nedited\n");
	write(join(worktree, "untracked.txt"), "untracked\n");

	packByHand(bridge, "full", repoId, diveId, pinnedRef);
	assert.equal(existsSync(worktree), false, "scope should be dehydrated before jump");

	const result = run(["jump"], bridge);
	assertOk(result, "jump failed");
	assert.match(result.stdout, new RegExp(`hydrated repo=${repoId}`));
	assert.match(result.stdout, new RegExp(`jumped dive ${diveId}: applied 3 artifact\\(s\\)`));

	const log = runTool("git", ["log", "--format=%s", pinnedRef + "..HEAD"], worktree).stdout.trim();
	assert.equal(log, "add feature b\nadd feature a", "commits should reapply oldest first");

	const status = runTool("git", ["status", "--porcelain"], worktree).stdout;
	assert.match(status, /^ M README\.md/m);
	assert.match(status, /^\?\? untracked\.txt/m);
	assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "base\nedited\n");

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.doesNotMatch(diveText, /rel: patch/, "applied patch links should be removed");
	assert.match(diveText, /diver: "Jump Test picked up jump-test\.nosedive"/);

	for (const suffix of ["a", "b", "c"]) {
		assert.equal(
			existsSync(join(bridge, "kb", `aaaaaaaa-1000-7000-8000-00000000000${suffix}.md`)),
			false,
			`applied memo ${suffix} should be deleted`,
		);
		assert.equal(
			existsSync(
				join(bridge, "kb", "artifacts", `aaaaaaaa-0000-7000-8000-00000000000${suffix}.patch`),
			),
			false,
			`applied patch ${suffix} should be deleted`,
		);
	}

	const markerText = readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8");
	assert.match(markerText, new RegExp(`id: ${diveId}`));

	const bridgeHead = runTool("git", ["rev-parse", "main"], bridge).stdout.trim();
	const originHead = runTool("git", ["rev-parse", "main"], origin).stdout.trim();
	assert.equal(bridgeHead, originHead, "jump should push the bridge to its remote");

	const commitSubject = runTool("git", ["log", "-1", "--format=%s"], bridge).stdout.trim();
	assert.equal(commitSubject, "Jump Test picked up jump-test.nosedive");

	// A second jump run has nothing left to apply (the chain was consumed and
	// its link removed above) -- hydration must not force the scope back to
	// its now-stale pin, silently discarding the reapplied commits.
	const rerun = run(["jump"], bridge);
	assertOk(rerun, "second jump run failed");
	assert.match(rerun.stdout, new RegExp(`jumped dive ${diveId}: nothing to unpack`));
	assert.equal(
		runTool("git", ["log", "--format=%s", pinnedRef + "..HEAD"], worktree).stdout.trim(),
		"add feature b\nadd feature a",
		"a re-run must not reset an already-caught-up scope back to its pin",
	);
});

test("jump with no patch links still hydrates the scoped repo", () => {
	const { bridge, repoId, diveId, pinnedRef } = setup("noop");
	const worktree = repoWorktree(bridge, "noop");
	assertOk(run(["dehydrate-repo.workspace", repoId, "--force"], bridge), "dehydrate failed");
	runTool("git", ["add", "-A"], bridge);
	gitCommit(bridge, "dehydrate scope for noop jump test");
	runTool("git", ["push"], bridge);

	const result = run(["jump"], bridge);
	assertOk(result, "jump failed on a dive with nothing to unpack");
	assert.match(result.stdout, new RegExp(`hydrated repo=${repoId}`));
	assert.match(result.stdout, new RegExp(`jumped dive ${diveId}: nothing to unpack`));
	assert.equal(
		existsSync(worktree),
		true,
		"scope should be hydrated even with no patches to apply",
	);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim(),
		pinnedRef,
		"scope should hydrate at the dive's pinned ref",
	);
});

test("jump leaves a corrupt chain for retry instead of aborting the whole run", () => {
	const { bridge, repoId, diveId, pinnedRef } = setup("corrupt");
	const worktree = repoWorktree(bridge, "corrupt");

	write(join(worktree, "feature-a.txt"), "a\n");
	runTool("git", ["add", "feature-a.txt"], worktree);
	gitCommit(worktree, "add feature a");
	write(join(worktree, "feature-b.txt"), "b\n");
	runTool("git", ["add", "feature-b.txt"], worktree);
	gitCommit(worktree, "add feature b");
	write(join(worktree, "README.md"), "base\nedited\n");
	write(join(worktree, "untracked.txt"), "untracked\n");

	packByHand(bridge, "corrupt", repoId, diveId, pinnedRef);

	// Simulate the real `pack` bug (gitRun trims format-patch stdout, which can
	// strip a trailing whitespace-only context line, not just a newline): drop
	// the diff's final line entirely so `git am` rejects it as corrupt.
	const patchPath = join(bridge, "kb", "artifacts", "aaaaaaaa-0000-7000-8000-00000000000b.patch");
	const patchText = readFileSync(patchPath, "utf8");
	writeFileSync(patchPath, patchText.split("\n").slice(0, -2).join("\n"));

	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump should report failure when a chain fails to apply");
	assert.match(result.stdout, new RegExp(`hydrated repo=${repoId}`));
	assert.match(
		result.stderr,
		/failed to apply patch chain[\s\S]*left un-applied on the dive for retry/,
	);
	assert.match(result.stderr, /1 patch chain\(s\) failed to apply/);

	const log = runTool("git", ["log", "--format=%s", pinnedRef + "..HEAD"], worktree).stdout.trim();
	assert.equal(log, "add feature a", "the chain's already-applied prefix should survive");

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.match(diveText, /rel: patch/, "the failed chain's link should remain for retry");
	assert.match(diveText, /diver: "Jump Test picked up jump-test\.nosedive"/);

	for (const suffix of ["a", "b", "c"]) {
		assert.equal(
			existsSync(join(bridge, "kb", `aaaaaaaa-1000-7000-8000-00000000000${suffix}.md`)),
			true,
			`un-applied memo ${suffix} should be left in place`,
		);
	}
});

test("jump rejects a patch memo whose meta.patch escapes kb/artifacts", () => {
	const { bridge, diveId } = setup("traversal");
	const kbDir = join(bridge, "kb");

	const decoyPath = join(tmp, "decoy.txt");
	write(decoyPath, "should survive\n");

	write(
		join(kbDir, "bbbbbbbb-1000-7000-8000-00000000000a.md"),
		`---
kind: memo
id: bbbbbbbb-1000-7000-8000-00000000000a
name: dirty.traversal-repo
gist: "malicious patch pointer"
meta:
  patch: kb/artifacts/../../../decoy.txt
---

`,
	);

	const divePath = join(kbDir, `${diveId}.md`);
	const diveText = readFileSync(divePath, "utf8");
	writeFileSync(
		divePath,
		diveText.replace(
			/^meta:/m,
			"links:\n  - kb/bbbbbbbb-1000-7000-8000-00000000000a.md:\n      rel: patch\nmeta:",
		),
	);

	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump should refuse a meta.patch that escapes kb/artifacts");
	assert.match(result.stderr, /unsafe meta\.patch/);
	assert.equal(readFileSync(decoyPath, "utf8"), "should survive\n", "decoy file must be untouched");
});
