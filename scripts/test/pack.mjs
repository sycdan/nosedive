import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
kind: effort
id: ${effortId}
name: pack-test.nosedive
gist: "Pack test effort"
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

	return { bridge, origin, source, repoId, effortId, diveId };
}

function repoWorktree(bridge, name) {
	return join(bridge, "workspace", `${name}-repo`);
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

test("pack captures ahead commits, dirty state, bridge-wip, pushes, and dehydrates", () => {
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
	assert.match(result.stdout, new RegExp(`dehydrated repo=${repoId} path=workspace/full-repo`));

	assert.equal(existsSync(worktree), false, "scoped repo should be dehydrated after pack");

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const linkBlocks = [
		...diveText.matchAll(/- (kb\/artifacts\/[0-9a-f-]{36}\.patch):\n((?:\s{6}.+\n)+)/g),
	];
	assert.equal(linkBlocks.length, 4, `expected 4 linked artifacts:\n${diveText}`);

	const [commitA, commitB, dirty, bridgeWip] = linkBlocks;
	assert.match(commitA[2], /rel: wip-patch/);
	assert.match(commitA[2], new RegExp(`repo: ${repoId}`));
	assert.match(commitA[2], /message: "?add feature a"?/);
	assert.match(commitA[2], /sha: [0-9a-f]{40}/);

	assert.match(commitB[2], new RegExp(`repo: ${repoId}`));
	assert.match(commitB[2], /message: "?add feature b"?/);

	assert.match(dirty[2], new RegExp(`repo: ${repoId}`));
	assert.match(dirty[2], /dirty: true/);
	assert.doesNotMatch(dirty[2], /sha:/);

	assert.match(bridgeWip[2], /rel: bridge-wip/);
	assert.doesNotMatch(bridgeWip[2], /repo:/);

	const patchDir = join(bridge, "kb", "artifacts");
	const commitAPatch = readFileSync(join(patchDir, `${commitA[1].split("/")[2]}`), "utf8");
	assert.match(commitAPatch, /Subject: \[PATCH\] add feature a/);
	assert.match(commitAPatch, /\+a/);

	const dirtyPatch = readFileSync(join(patchDir, `${dirty[1].split("/")[2]}`), "utf8");
	assert.match(dirtyPatch, /\+edited/);
	assert.match(dirtyPatch, /untracked\.txt/);

	const bridgeWipPatch = readFileSync(join(patchDir, `${bridgeWip[1].split("/")[2]}`), "utf8");
	assert.match(bridgeWipPatch, /Extra bridge WIP line\./);

	const log = runTool("git", ["log", "-1", "--format=%s"], bridge).stdout.trim();
	assert.equal(log, `dive(${diveText.match(/^name: (.+)$/m)[1]}): packed wip`);

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

test("pack with nothing to capture still tears down and reports no-op", () => {
	const { bridge, repoId, diveId } = setup("clean");
	const worktree = repoWorktree(bridge, "clean");
	const beforeHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed on a clean scope");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: nothing to pack`));
	assert.match(result.stdout, new RegExp(`dehydrated repo=${repoId}`));
	assert.equal(existsSync(worktree), false);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(),
		beforeHead,
		"a pack with nothing to capture should not create a commit",
	);
});
