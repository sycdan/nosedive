import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	escapeRegExp,
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

const workBranch = "work/land-test.nosedive";

/** The published head of the shared work branch, or "" when the branch is absent. */
function remoteWorkBranch(source) {
	const shown = runGitUnchecked(
		["show-ref", "--verify", "--hash", `refs/heads/${workBranch}`],
		source,
	);
	return shown.status === 0 ? shown.stdout.trim() : "";
}

function scopePin(bridge, diveId) {
	const text = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const pin = /^\s+ref: ([0-9a-f]{40})$/m.exec(text)?.[1];
	assert.ok(pin, "dive should have a scope pin");
	return pin;
}

/**
 * A head that is a sibling of the pin rather than a descendant of it -- the
 * shape a rebase leaves behind, and the only shape a plain push cannot publish.
 */
function rewriteHead(worktree, message) {
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"--amend",
			"--allow-empty",
			"-m",
			message,
		],
		worktree,
	);
	return runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim();
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
	const rawPath = runTool(
		"git",
		["rev-parse", "--git-path", "hooks/pre-push"],
		worktree,
	).stdout.trim();
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
	assert.match(result.stdout, /^nosedive preflight$/m, "land should end by naming preflight");
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
	assert.match(result.stderr, /land refused because scoped worktree\(s\) are dirty/);
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
	assert.doesNotMatch(result.stderr, /\(no scoped repos to push\)/);

	// Naming a branch is all it takes to make the same commits landable.
	assertOk(run(["record.dive", "--ref", diveId, "--upscope", repoId], bridge), "--upscope failed");
	assertOk(run(["land"], bridge), "land should accept the scope once it names a branch");
});

test("land silently accepts a scope whose HEAD matches its pin and names no work branch", () => {
	const { bridge, worktree, diveId } = setup("readonly-equals-pin");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	write(divePath, readFileSync(divePath, "utf8").replace(/^      work-branch: .*\n/m, ""));
	const result = run(["land"], bridge);
	assertOk(result, "land unexpectedly refused a scope that matches its pin");
	assert.doesNotMatch(result.stderr, /land refused because scope .* is (ahead|behind) pinned ref/);
	assert.doesNotMatch(result.stderr, /names no work branch/);
});

test("land refuses a scope that is behind its pin and names no work branch", () => {
	const { bridge, worktree, diveId } = setup("readonly-behind");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	write(divePath, readFileSync(divePath, "utf8").replace(/^      work-branch: .*\n/m, ""));
	const earlier = runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim();
	gitCommitEmpty(worktree, "work moved past the pin");
	const moved = runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim();
	const sourceUrl = runTool(
		"git",
		["config", "--get", "remote.origin.url"],
		worktree,
	).stdout.trim();
	runTool("git", ["push", sourceUrl, `HEAD:refs/heads/${workBranch}`], worktree);
	assertOk(run(["record.dive", "--ref", diveId, "--repin", workBranch, "--scope", repoId], bridge));
	runTool("git", ["checkout", earlier], worktree);

	const result = run(["land"], bridge);
	assert.notEqual(
		result.status,
		0,
		"land unexpectedly accepted a scope that had rolled back behind its pin",
	);
	assert.match(result.stderr, new RegExp(`scope ${repoId} is behind pinned ref`));
	assert.match(result.stderr, /names no work branch/);
	assert.match(result.stderr, /--upscope/);
	assert.doesNotMatch(result.stderr, /\(no scoped repos to push\)/);
	assert.match(
		result.stderr,
		new RegExp(
			`Run \`(?:node .+|npx -y nosedive@[^ ]+) record\\.dive --ref ${diveId} --upscope ${repoId}\``,
		),
	);
	assert.match(result.stderr, /work\/land-test\.nosedive/);
	assert.match(result.stderr, /branch convention may differ/);
});

/**
 * The lease case the whole flag exists for: a work branch built by earlier
 * dives, rebased onto a trunk it conflicted with, republished over a remote
 * that has not moved since this dive pinned it.
 */
test("land --hard publishes a head the remote work branch does not descend from", () => {
	const { bridge, worktree, diveId } = setup("hard-publishes");
	const source = join(tmp, "hard-publishes-source");
	const pin = scopePin(bridge, diveId);
	runTool("git", ["branch", workBranch, pin], source);
	const head = rewriteHead(worktree, "rewritten history");
	assert.notEqual(head, pin, "the fixture must rewrite the pinned commit");

	assertOk(run(["land", "--hard"], bridge), "land --hard failed");
	assert.equal(remoteWorkBranch(source), head, "land --hard must replace the branch");
	assert.match(readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"), /^kind: memo$/m);
});

test("plain land still refuses a head the remote work branch does not descend from", () => {
	const { bridge, worktree, diveId } = setup("plain-refuses-rewrite");
	const source = join(tmp, "plain-refuses-rewrite-source");
	const pin = scopePin(bridge, diveId);
	runTool("git", ["branch", workBranch, pin], source);
	rewriteHead(worktree, "rewritten history");

	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "plain land unexpectedly published a rewritten head");
	assert.match(result.stderr, new RegExp(`scope ${repoId} does not descend from`));
	assert.match(result.stderr, new RegExp(escapeRegExp(workBranch)));
	assert.match(result.stderr, /land --hard/, "the rewrite case names the flag that publishes it");
	assert.doesNotMatch(result.stderr, /land: no land gates selected/, "refused before gates");
	assert.equal(remoteWorkBranch(source), pin, "a refused plain land must not move the remote");
});

/**
 * The second and every later dive of a feat: the previous land moved the work
 * branch, so this dive's pin is behind it and the push cannot fast-forward.
 * That was only discovered after a full gate run, and the recovery -- repin and
 * replay -- was nowhere in the output.
 */
test("land refuses a scope whose work branch has moved past the pin, before running gates", () => {
	const { bridge, worktree, diveId } = setup("branch-moved-past-pin");
	const source = join(tmp, "branch-moved-past-pin-source");
	const pin = scopePin(bridge, diveId);
	write(join(source, "earlier-dive.txt"), "an earlier dive landed here\n");
	runTool("git", ["add", "earlier-dive.txt"], source);
	gitCommit(source, "an earlier dive's land");
	const advanced = runTool("git", ["rev-parse", "HEAD"], source).stdout.trim();
	runTool("git", ["branch", workBranch, advanced], source);
	gitCommitEmpty(worktree, "landable work");

	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land unexpectedly attempted a push that cannot fast-forward");
	assert.match(result.stderr, new RegExp(`scope ${repoId} cannot fast-forward`));
	assert.match(result.stderr, new RegExp(escapeRegExp(workBranch)), "name the branch");
	assert.match(result.stderr, new RegExp(advanced), "name where the branch stands");
	assert.match(result.stderr, new RegExp(pin), "and the pin this dive holds");
	assert.match(
		result.stderr,
		new RegExp(`record\.dive --ref ${diveId} --repin`),
		"name the repin that fixes it",
	);
	assert.match(result.stderr, / pack$/m, "and the pack that saves the work first");
	assert.match(result.stderr, new RegExp(` jump ${diveId}$`, "m"), "and the replay");
	assert.doesNotMatch(result.stderr, /land: no land gates selected/, "refused before gates");
	assert.doesNotMatch(result.stderr, /land: pushing scope/);
	assert.equal(remoteWorkBranch(source), advanced, "a refused land must not move the remote");
	assert.match(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
		/^kind: dive$/m,
		"a refused land must leave the dive open",
	);
});

test("land publishes a scope whose work branch it already contains", () => {
	const { bridge, worktree, diveId } = setup("branch-already-contained");
	const source = join(tmp, "branch-already-contained-source");
	runTool("git", ["branch", workBranch, scopePin(bridge, diveId)], source);
	gitCommitEmpty(worktree, "landable work");
	const head = runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim();

	assertOk(run(["land"], bridge), "land refused a plain fast-forward");
	assert.equal(remoteWorkBranch(source), head, "the fast-forward must publish");
});

test("land --hard refuses a moved work branch before running gates", () => {
	const { bridge, worktree } = setup("hard-stale-lease-pregate");
	const source = join(tmp, "hard-stale-lease-pregate-source");
	gitCommitEmpty(source, "third-party work on the shared branch");
	runTool("git", ["branch", workBranch, "HEAD"], source);
	gitCommitEmpty(worktree, "landable work");

	const result = run(["land", "--hard"], bridge);
	assert.notEqual(result.status, 0, "land --hard unexpectedly replaced a branch that had moved");
	assert.match(result.stderr, /moved since this dive was pinned/);
	assert.doesNotMatch(result.stderr, /land: no land gates selected/, "refused before gates");
});

test("land --hard refuses when the remote work branch has moved away from the pin", () => {
	const { bridge, worktree, diveId } = setup("hard-stale-lease");
	const source = join(tmp, "hard-stale-lease-source");
	const pin = scopePin(bridge, diveId);
	write(join(source, "third-party.txt"), "somebody else was here\n");
	runTool("git", ["add", "third-party.txt"], source);
	gitCommit(source, "third-party work on the shared branch");
	const advanced = runTool("git", ["rev-parse", "HEAD"], source).stdout.trim();
	runTool("git", ["branch", workBranch, advanced], source);
	gitCommitEmpty(worktree, "landable work");

	const result = run(["land", "--hard"], bridge);
	assert.notEqual(result.status, 0, "land --hard unexpectedly replaced a branch that had moved");
	assert.match(result.stderr, new RegExp(escapeRegExp(workBranch)), "name the branch");
	assert.match(result.stderr, new RegExp(pin), "name the pin the lease expected");
	assert.match(result.stderr, /moved since this dive was pinned/, "say what went wrong");
	assert.match(result.stderr, /--repin/, "and name the recovery");
});

/**
 * A refused lease has to cost nothing: the pilot must be able to repin, rebase
 * and try again from exactly where they stood.
 */
test("a land --hard refused by the lease leaves remote, dive and marker untouched", () => {
	const { bridge, worktree, diveId } = setup("hard-refusal-inert");
	const source = join(tmp, "hard-refusal-inert-source");
	write(join(source, "third-party.txt"), "somebody else was here\n");
	runTool("git", ["add", "third-party.txt"], source);
	gitCommit(source, "third-party work on the shared branch");
	const advanced = runTool("git", ["rev-parse", "HEAD"], source).stdout.trim();
	runTool("git", ["branch", workBranch, advanced], source);
	gitCommitEmpty(worktree, "landable work");

	const result = run(["land", "--hard"], bridge);
	assert.notEqual(result.status, 0, "land --hard unexpectedly replaced a branch that had moved");
	assert.equal(remoteWorkBranch(source), advanced, "a refused land must not move the remote");
	assert.match(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
		/^kind: dive$/m,
		"a refused land must leave the dive open",
	);
	assert.equal(
		existsSync(join(bridge, "workspace", ".nosedive-ref")),
		true,
		"a refused land must leave the active dive marker in place",
	);
});

/**
 * An absent branch is a stale lease too: a non-empty expected value against a
 * ref that is not there is exactly what must not be created behind the pilot.
 */
test("land --hard refuses when the remote work branch is absent rather than creating it", () => {
	const { bridge, worktree, diveId } = setup("hard-absent-branch");
	const source = join(tmp, "hard-absent-branch-source");
	const pin = scopePin(bridge, diveId);
	gitCommitEmpty(worktree, "landable work");
	assert.equal(remoteWorkBranch(source), "", "the fixture must start with no work branch");

	const result = run(["land", "--hard"], bridge);
	assert.notEqual(result.status, 0, "land --hard unexpectedly created an absent work branch");
	assert.equal(remoteWorkBranch(source), "", "land --hard must not create the branch");
	assert.match(result.stderr, new RegExp(escapeRegExp(workBranch)));
	assert.match(result.stderr, new RegExp(pin));
});

test("land still rejects an unknown option", () => {
	const { bridge } = setup("hard-unknown-option");
	const result = run(["land", "--soft"], bridge);
	assert.notEqual(result.status, 0, "land unexpectedly accepted an unknown option");
	assert.match(result.stderr, /unknown land option: --soft/);
});
