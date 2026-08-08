import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  - ${repoId}
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
	return { bridge, worktree: join(bridge, "workspace", `${name}-repo`), diveId };
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
	assert.equal(runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim(), head);
	assert.notEqual(head, trunk, "land must not reset the worktree to fetched trunk");
	assert.notEqual(runGitUnchecked(["symbolic-ref", "-q", "HEAD"], worktree).status, 0);
	assert.equal(runTool("git", ["status", "--porcelain"], worktree).stdout, "");
	assert.equal(existsSync(join(worktree, ".nosedive-ref")), true, "managed marker should remain");
	const commitBody = runTool("git", ["log", "-1", "--format=%B"], bridge).stdout;
	assert.match(commitBody, new RegExp(`Effort: ${effortId}`));
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

test("land refuses a read-only scope that has commits past its pin", () => {
	const { bridge, worktree, diveId } = setup("readonly");
	gitCommitEmpty(worktree, "read-only work");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	const diveText = readFileSync(divePath, "utf8");
	write(divePath, diveText.replace("mode: rw", "mode: ro"));
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land unexpectedly accepted read-only commits");
	assert.match(result.stderr, new RegExp(`read-only scope ${repoId} is ahead of pinned ref`));
	assert.match(result.stderr, /[0-9a-f]{7,}/, "refusal should name the ahead commit");
});
