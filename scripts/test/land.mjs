import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	gitCommitEmpty,
	packageVersionPattern,
	run,
	runGitUnchecked,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("land");
const repoId = "019fd470-0000-7000-8000-000000000001";
const effortId = "019fd470-0000-7000-8000-000000000002";

function setup(name, repoMeta = "") {
	const source = join(tmp, `${name}-source`);
	const bridge = join(tmp, name);
	const origin = join(tmp, `${name}-origin.git`);
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, "base");

	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Nosedive Test"], bridge);
	runTool("git", ["config", "user.email", "nosedive@example.invalid"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: ${name}-repo
gist: "Land test repo"
meta:
  path: workspace/${name}-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
${repoMeta}---
`,
	);
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: land-test.nosedive
gist: "Land test effort"
scopes:
  - ${repoId}:
      work-branch: work/land-test.nosedive
---
`,
	);
	runTool("git", ["add", "--", "kb", ".nosedive"], bridge);
	gitCommit(bridge, "initial bridge state");
	mkdirSync(origin, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], origin);
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);
	assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate failed");
	const dive = run(
		["record.dive", "--effort", effortId, "--diver", "nosedive@example.invalid"],
		bridge,
	);
	assertOk(dive, "record.dive failed");
	const diveId = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(dive.stdout)?.[1];
	assert.ok(diveId, `record.dive did not report a dive id:\n${dive.stdout}`);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "record dive");
	return { bridge, origin, worktree: join(bridge, "workspace", `${name}-repo`), diveId };
}

function assertInOrder(text, parts) {
	let offset = 0;
	for (const part of parts) {
		const index = text.indexOf(part, offset);
		assert.notEqual(index, -1, `missing ${JSON.stringify(part)} after offset ${offset}:\n${text}`);
		offset = index + part.length;
	}
}

function installPrePushHook(worktree, body) {
	const rawPath = runTool("git", ["rev-parse", "--git-path", "hooks/pre-push"], worktree).stdout.trim();
	const hookPath = isAbsolute(rawPath) ? rawPath : join(worktree, rawPath);
	write(hookPath, body);
	chmodSync(hookPath, 0o755);
}

test("land refuses when no dive is on deck", () => {
	const bridge = join(tmp, "no-marker");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land without a dive marker unexpectedly succeeded");
	assert.match(result.stderr, /^nosedive-error: \S/m);
	assert.match(result.stderr, /render 019fe2f7-5922-72d5-abda-b5b8cb7300cf/);
});

test("land retains the worktree at the pushed HEAD commit", () => {
	const { bridge, worktree, diveId } = setup("provenance");
	const scratchDir = join(bridge, "workspace", ".scratch", diveId);
	write(join(scratchDir, "temp.txt"), "delete me\n");
	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const pin = /^\s+ref: ([0-9a-f]{40})$/m.exec(diveText)?.[1];
	assert.ok(pin, "dive should have a scope pin");
	const source = join(tmp, "provenance-source");
	write(join(source, "README.md"), "advanced trunk\n");
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, "advance trunk");
	const trunk = runTool("git", ["rev-parse", "main"], source).stdout.trim();
	assert.notEqual(trunk, pin, "test must advance trunk beyond the dive pin");
	gitCommitEmpty(worktree, "landable work");
	const head = runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim();
	const result = run(["land"], bridge);
	assertOk(result, "land failed");
	assert.equal(existsSync(scratchDir), false, "land should remove dive scratch space");
	assert.equal(runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim(), head);
	assert.notEqual(head, trunk, "land must not reset the worktree to fetched trunk");
	assert.notEqual(runGitUnchecked(["symbolic-ref", "-q", "HEAD"], worktree).status, 0);
	assert.equal(runTool("git", ["status", "--porcelain"], worktree).stdout, "");
	assert.equal(existsSync(join(worktree, ".nosedive-ref")), true, "managed marker should remain");
	const commitBody = runTool("git", ["log", "-1", "--format=%B"], bridge).stdout;
	assert.match(commitBody, new RegExp(`Feat: ${effortId}`));
	assert.match(
		commitBody,
		new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern} <noreply@nosedive\\.dev>`),
	);
	assert.equal((commitBody.match(/Co-Authored-By: nosedive/g) ?? []).length, 1);
});

/**
 * The whole never-unblock design rests on this git behavior: a `pushurl`
 * override applies only to the named remote, so land can publish by resolved
 * URL from a worktree an agent cannot push from. If this ever regresses,
 * hydrated worktrees would have to be unblocked to land.
 */
test("a pushurl sentinel blocks the named remote but not the resolved URL", () => {
	const { bridge, worktree } = setup("url-push");
	const sentinel = runTool(
		"git",
		["config", "--worktree", "--get", "remote.origin.pushurl"],
		worktree,
	).stdout.trim();
	assert.equal(sentinel, "nosedive-render-587d3f73-2534-5179-b111-ce6c83d6814d");

	gitCommitEmpty(worktree, "agent work");
	const blocked = runGitUnchecked(["push", "origin", "HEAD:refs/heads/agent-attempt"], worktree);
	assert.notEqual(blocked.status, 0, "pushing to the named remote must stay blocked");
	assert.match(blocked.stderr, /nosedive-render-587d3f73-2534-5179-b111-ce6c83d6814d/);

	const noVerify = runGitUnchecked(
		["push", "--no-verify", "origin", "HEAD:refs/heads/agent-attempt"],
		worktree,
	);
	assert.notEqual(noVerify.status, 0, "--no-verify must not defeat a pushurl override");

	const url = runTool("git", ["config", "--get", "remote.origin.url"], worktree).stdout.trim();
	runTool("git", ["push", url, "HEAD:refs/heads/land-attempt"], worktree);
	assert.equal(
		runTool(
			"git",
			["config", "--worktree", "--get", "remote.origin.pushurl"],
			worktree,
		).stdout.trim(),
		sentinel,
		"landing must not disturb the sentinel",
	);
	// runTool asserts a zero exit: fetch must keep working through the override.
	runTool("git", ["fetch", "origin"], worktree);
});

test("land publishes without ever lifting push isolation", () => {
	const { bridge, worktree } = setup("isolation-kept");
	const before = runTool(
		"git",
		["config", "--worktree", "--get", "remote.origin.pushurl"],
		worktree,
	).stdout.trim();
	gitCommitEmpty(worktree, "landable work");
	assertOk(run(["land"], bridge), "land failed");
	assert.equal(
		runTool(
			"git",
			["config", "--worktree", "--get", "remote.origin.pushurl"],
			worktree,
		).stdout.trim(),
		before,
		"land must leave the sentinel exactly as it found it",
	);
});

test("land refuses a dirty scoped worktree before running gates or pushing", () => {
	const { bridge, worktree } = setup("dirty-worktree");
	write(join(worktree, "README.md"), "dirty\n");

	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land unexpectedly accepted a dirty scoped worktree");
	assert.match(result.stderr, /land refuses: scoped worktree\(s\) are dirty/);
	assert.match(result.stderr, new RegExp(`scope ${repoId}`));
	assert.match(result.stderr, /M README\.md/);
	assert.match(result.stderr, /Suggested git commands:/);
	assert.match(result.stderr, /git -C 'workspace\/dirty-worktree-repo' add -A/);
	assert.match(
		result.stderr,
		/git -C 'workspace\/dirty-worktree-repo' commit -m 'Working on Land Test\.'/,
	);
	assert.doesNotMatch(result.stderr, /land: no land gates selected/);
	assert.doesNotMatch(result.stderr, /land: pushing scope/);
});

test("land reports concise lifecycle progress while publishing", () => {
	const { bridge, worktree } = setup("progress");
	gitCommitEmpty(worktree, "landable work");
	const result = run(["land"], bridge);
	assertOk(result, "land failed");
	assertInOrder(result.stderr, [
		"land: no land gates selected",
		`land: pushing scope ${repoId} -> work/land-test.nosedive`,
		`land: pushed scope ${repoId} -> work/land-test.nosedive`,
		"land: closing bridge dive",
		"land: syncing bridge from origin/main",
		"land: committing bridge outcome",
		"land: pushing bridge",
		"land: bridge push complete",
	]);
});

test("land progress names the last completed phase before a later failure", () => {
	const { bridge, origin, worktree } = setup("progress-fetch-fails");
	gitCommitEmpty(worktree, "landable work");
	rmSync(origin, { recursive: true, force: true });

	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land unexpectedly succeeded after its bridge remote vanished");
	assertInOrder(result.stderr, [
		"land: no land gates selected",
		`land: pushing scope ${repoId} -> work/land-test.nosedive`,
		`land: pushed scope ${repoId} -> work/land-test.nosedive`,
		"land: closing bridge dive",
		"land: syncing bridge from origin/main",
	]);
	assert.doesNotMatch(result.stderr, /land: bridge push complete/);
	assert.match(result.stderr, /failed to fetch bridge remote before land push/);
});

test("land surfaces pre-push hook output when a push fails", () => {
	const { bridge, worktree } = setup("prepush-detail");
	gitCommitEmpty(worktree, "landable work");
	installPrePushHook(
		worktree,
		"#!/bin/sh\nprintf '%s\\n' 'pre-push: custom failure from stdout'\nexit 1\n",
	);

	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land unexpectedly succeeded past a failing pre-push hook");
	assert.match(result.stderr, /failed to push/);
	assert.match(result.stderr, /error: failed to push some refs/);
	assert.match(result.stderr, /pre-push: custom failure from stdout/);
});

/**
 * Work with nowhere to go. The refusal has to leave the pilot able to act: they
 * are looking at commits they already made, so it names the fix, the branch the
 * fix would use, and the reason to look at that branch before accepting it.
 */
test("land refuses a scope that is ahead of its pin and names no work branch", () => {
	const { bridge, worktree, diveId } = setup("readonly");
	gitCommitEmpty(worktree, "unpublishable work");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	// Taking the branch away is the whole of what makes a scope read-only now.
	write(divePath, readFileSync(divePath, "utf8").replace(/^      work-branch: .*\n/m, ""));
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land unexpectedly accepted unpublishable commits");
	assert.match(result.stderr, new RegExp(`scope ${repoId} is ahead of pinned ref`));
	assert.match(result.stderr, /names no work branch/);
	assert.match(result.stderr, /[0-9a-f]{7,}/, "refusal should name the ahead commit");
	assert.match(
		result.stderr,
		new RegExp(
			`Run \`(?:node .+|npx -y nosedive@[^ ]+) record\\.dive --ref ${diveId} --upscope ${repoId}\``,
		),
		"the refusal must name the command that fixes it",
	);
	assert.doesNotMatch(result.stderr, /Run `nosedive record\.dive/);
	assert.match(result.stderr, /work\/land-test\.nosedive/, "and the branch that would be used");
	assert.match(result.stderr, /branch convention may differ/, "and why to check it first");

	// Naming a branch is all it takes to make the same commits landable.
	assertOk(run(["record.dive", "--ref", diveId, "--upscope", repoId], bridge), "--upscope failed");
	assertOk(run(["land"], bridge), "land should accept the scope once it names a branch");
});
