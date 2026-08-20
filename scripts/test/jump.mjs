import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	gitCommitEmpty,
	packageVersion,
	packageVersionPattern,
	posixShell,
	run,
	runGitUnchecked,
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

/**
 * `repos: 2` scopes a second repo on the same feat. Batched refusals are only
 * observable across more than one scope: with a single repo, reporting each
 * failure as it is found and reporting them all at once are the same output.
 */
function setup(name, { repos = 1 } = {}) {
	const origin = bareRemote(`${name}-origin.git`);
	const bridge = join(tmp, name);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Jump Test"], bridge);
	runTool("git", ["config", "user.email", "jump@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });

	const featId = "019fcf10-0000-7000-8000-00000000000f";
	const scopeNames = [];
	const repoIds = [];
	const sources = [];
	for (let index = 0; index < repos; index += 1) {
		const scopeName = index === 0 ? name : `${name}-${index + 1}`;
		const repoId = `019fcf10-0000-7000-8000-00000000000${index + 1}`;
		const source = sourceRepo(`${scopeName}-source`);
		scopeNames.push(scopeName);
		repoIds.push(repoId);
		sources.push(source);
		write(
			join(bridge, "kb", `${repoId}.md`),
			`---
kind: repo
id: ${repoId}
name: ${scopeName}-repo
gist: "Jump test scoped repo"
meta:
  path: workspace/${scopeName}-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
---
`,
		);
	}
	const featScopes = repoIds
		.map((repoId) => `  - ${repoId}:\n      work-branch: work/jump-test.nosedive`)
		.join("\n");
	write(
		join(bridge, "kb", `${featId}.md`),
		`---
kind: feat
id: ${featId}
name: jump-test.nosedive
gist: "Jump test feat"
scopes:
${featScopes}
---

# Jump Test
`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "initial bridge state");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	for (const repoId of repoIds) {
		assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate scoped repo failed");
	}
	const diveResult = run(
		["record.dive", "--feat", featId, "--diver", "jump@example.test", "--brief", "Test brief."],
		bridge,
	);
	assertOk(diveResult, "record.dive failed");
	const diveId = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(diveResult.stdout)?.[1];
	assert.ok(diveId, `record.dive did not report a dive id:\n${diveResult.stdout}`);

	const pinnedRefs = scopeNames.map((scopeName) =>
		runTool("git", ["rev-parse", "HEAD"], repoWorktree(bridge, scopeName)).stdout.trim(),
	);

	return {
		bridge,
		origin,
		source: sources[0],
		sources,
		repoId: repoIds[0],
		repoIds,
		scopeNames,
		featId,
		diveId,
		pinnedRef: pinnedRefs[0],
		pinnedRefs,
	};
}

function repoWorktree(bridge, name) {
	return join(bridge, "workspace", `${name}-repo`);
}

/**
 * Points every one of the dive's scope pins at whatever its worktree is sitting
 * on now. `jump` refuses to move a worktree off commits no ref contains, so a
 * fixture that commits in a hydrated worktree and then runs `jump` has to say
 * the dive means those commits -- which is what `record.dive --repin` does in
 * real use, and it refuses on the active dive.
 */
function repinByHand(bridge, diveId, scopeNames) {
	const divePath = join(bridge, "kb", `${diveId}.md`);
	let text = readFileSync(divePath, "utf8");
	const heads = scopeNames.map((scopeName) =>
		runTool("git", ["rev-parse", "HEAD"], repoWorktree(bridge, scopeName)).stdout.trim(),
	);
	let index = 0;
	text = text.replace(/^(\s+)ref: .*$/gm, (line, indent) => `${indent}ref: ${heads[index++]}`);
	assert.equal(index, heads.length, `expected ${heads.length} scope ref lines in the dive doc`);
	writeFileSync(divePath, text);
	return heads;
}

/** The commit a detached worktree is on, as jump's refusal reports it. */
function worktreeHead(bridge, scopeName) {
	return runTool("git", ["rev-parse", "HEAD"], repoWorktree(bridge, scopeName)).stdout.trim();
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

test("jump with no available dive explains how to create one", () => {
	const bridge = join(tmp, "no-marker");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	// The kb directory exists and is empty: `jump` reads it to say what could
	// have been jumped instead, and a missing directory would be a different
	// complaint than the one this test is about.
	mkdirSync(join(bridge, "kb"), { recursive: true });
	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump without a dive marker unexpectedly succeeded");
	assert.match(result.stderr, /no dive is available to pick up/);
	assert.match(result.stderr, /record\.dive/);
	assert.doesNotMatch(result.stderr, /nosedive-error:/);
});

test("jump refuses an unbriefed dive before hydrating its scopes", () => {
	const { bridge, repoId, diveId } = setup("unbriefed");
	const worktree = repoWorktree(bridge, "unbriefed");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	writeFileSync(divePath, readFileSync(divePath, "utf8").replace(/\n## Brief\n[\s\S]*$/, "\n"));
	assertOk(run(["dehydrate-repo.workspace", repoId, "--force"], bridge), "dehydrate failed");

	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump unexpectedly accepted an unbriefed dive");
	assert.match(result.stderr, new RegExp(`dive ${diveId} has no "## Brief" section`));
	assert.equal(existsSync(worktree), false, "jump should refuse before hydrating the scope");
});

test("jump hydrates a packed dive's scoped repos and reapplies every patch chain", () => {
	const { bridge, origin, repoId, featId, diveId, pinnedRef } = setup("full");
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
	const scratchDir = join(bridge, "workspace", ".scratch", diveId);
	assert.equal(existsSync(scratchDir), true, "jump should create dive scratch space");
	assert.match(
		result.stdout,
		new RegExp(`Scratch space for this dive: workspace/\\.scratch/${diveId}/`),
	);
	assert.match(result.stdout, /Write temp files there, never \/tmp/);
	assert.match(result.stdout, /pack will not capture it/);

	const log = runTool("git", ["log", "--format=%s", pinnedRef + "..HEAD"], worktree).stdout.trim();
	assert.equal(log, "add feature b\nadd feature a", "commits should reapply oldest first");

	const status = runTool("git", ["status", "--porcelain"], worktree).stdout;
	assert.match(status, /^ M README\.md/m);
	assert.match(status, /^\?\? untracked\.txt/m);
	assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "base\nedited\n");

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.doesNotMatch(diveText, /rel: patch/, "applied patch links should be removed");
	assert.match(diveText, /diver: "jump@example\.test"/);
	assert.match(
		diveText,
		/^## jumped \d{4}-\d{2}-\d{2}T[\d:.]+Z\s*$/im,
		"a labelled, timestamped hydrated-section heading should be appended",
	);
	// The lead line is the whole point of the section carrying a label: a reader
	// a month later gets the event, the holder and the feat before the paths.
	// The holder is written in git's author form when it is this pilot, whose
	// `user.name` the fixture sets -- see the deck-lead test below.
	assert.match(
		diveText,
		/^Jump Test <jump@example\.test> picked up jump-test\.nosedive, hydrating 1 scoped repo\.$/m,
		"the section should say who picked the dive up and what for",
	);
	assert.match(
		diveText,
		new RegExp(`repo=full-repo path=\\S+ work-branch=work/jump-test.nosedive ref=${pinnedRef}`),
		"the hydrated section should name the scoped repo, its path, work branch, and pinned ref",
	);

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

	const pushedDiveText = runTool("git", ["show", `origin/main:kb/${diveId}.md`], bridge).stdout;
	assert.match(
		pushedDiveText,
		new RegExp(`repo=full-repo path=\\S+ work-branch=work/jump-test.nosedive ref=${pinnedRef}`),
		"the hydrated section should be part of the commit jump pushes",
	);

	const commitSubject = runTool("git", ["log", "-1", "--format=%s"], bridge).stdout.trim();
	assert.match(commitSubject, /^jump\(jump-test\.nosedive\.[0-9a-f]{6}\): unpacked work$/);
	const commitBody = runTool("git", ["log", "-1", "--format=%B"], bridge).stdout;
	assert.match(commitBody, new RegExp(`Feat: ${featId}`));
	assert.match(
		commitBody,
		new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern} <noreply@nosedive\\.dev>`),
	);
	assert.equal((commitBody.match(/Co-Authored-By: nosedive/g) ?? []).length, 1);

	// A second jump run has nothing left to apply (the chain was consumed and
	// its link removed above). The reapplied commits are locally minted and no
	// ref contains them, so the pin has to be moved onto them first -- exactly
	// the `record.dive --repin` a real re-jump runs -- and then hydration must
	// leave the scope where it stands rather than reset it.
	repinByHand(bridge, diveId, ["full"]);
	write(join(scratchDir, "stale.tmp"), "remove me\n");
	const rerun = run(["jump"], bridge);
	assertOk(rerun, "second jump run failed");
	assert.match(rerun.stdout, new RegExp(`jumped dive ${diveId}: nothing to unpack`));
	assert.deepEqual(readdirSync(scratchDir), [], "re-jump should clear existing scratch space");
	assert.equal(
		runTool("git", ["log", "--format=%s", pinnedRef + "..HEAD"], worktree).stdout.trim(),
		"add feature b\nadd feature a",
		"a re-run must not reset an already-caught-up scope back to its pin",
	);
});

/**
 * Every dive recorded before `record.dive` wrote `meta.feat` carries the older
 * spelling, and the parser's fallback is a live promise to all of them. Nothing
 * else in this file can see it any more: the fixture dives come from
 * `record.dive`, so they all carry the canonical key now.
 */
test("jump reads a dive that names its feat in meta.effort", () => {
	const { bridge, featId, diveId } = setup("legacy-feat-key");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	writeFileSync(
		divePath,
		readFileSync(divePath, "utf8").replace(`  feat: ${featId}`, `  effort: ${featId}`),
	);
	runTool("git", ["add", "-A"], bridge);
	gitCommit(bridge, "put the dive back on the superseded feat key");
	runTool("git", ["push"], bridge);

	const result = run(["jump"], bridge);
	assertOk(result, "jump failed on a dive naming its feat in meta.effort");
	assert.match(result.stdout, new RegExp(`jumped dive ${diveId}`));
});

test("jump with no patch links still hydrates the scoped repo", () => {
	const { bridge, repoId, featId, diveId, pinnedRef } = setup("noop");
	const worktree = repoWorktree(bridge, "noop");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	writeFileSync(
		divePath,
		readFileSync(divePath, "utf8").replace(`feat: ${featId}`, "feat: jump-test.nosedive"),
	);
	assertOk(run(["dehydrate-repo.workspace", repoId, "--force"], bridge), "dehydrate failed");
	runTool("git", ["add", "-A"], bridge);
	gitCommit(bridge, "dehydrate scope for noop jump test");
	runTool("git", ["push"], bridge);

	const result = run(["jump"], bridge);
	assertOk(result, "jump failed on a dive with nothing to unpack");
	assert.match(result.stdout, new RegExp(`hydrated repo=${repoId}`));
	assert.match(result.stdout, new RegExp(`jumped dive ${diveId}: nothing to unpack`));
	assert.match(result.stdout, new RegExp(`Read the dive at kb/${diveId}\\.md in full`));
	assert.match(result.stdout, new RegExp(`Read the feat it serves at kb/${featId}\\.md`));
	assert.match(result.stdout, /whatever those two link to in their frontmatter/);
	assert.match(result.stdout, /do the work, to the endpoint the brief names -- not more/);
	assert.match(result.stdout, /Commit completed work in every writable scoped repo/);
	assert.match(result.stdout, /each resulting commit SHA/);
	assert.match(result.stdout, /Do not edit the brief or change any scope pin/);
	assert.match(
		result.stdout,
		/Never push an implementation repo: only land may push to implementation remotes/,
	);
	assert.match(
		result.stdout,
		new RegExp(`Scratch space for this dive: workspace/\\.scratch/${diveId}/`),
	);
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

test("jump installs provenance for commits made in its hydrated worktree", () => {
	const { bridge, repoId, featId, diveId } = setup("commit-hook");
	const worktree = repoWorktree(bridge, "commit-hook");

	assertOk(run(["jump"], bridge), "jump failed");
	write(join(worktree, "implementation.txt"), "implemented\n");
	runTool("git", ["add", "implementation.txt"], worktree);
	gitCommit(worktree, "implementation");

	const message = runTool("git", ["log", "-1", "--format=%B"], worktree).stdout.trim();
	assert.equal(
		message,
		`implementation\n\nDive: ${diveId}\nFeat: ${featId}\nCo-Authored-By: nosedive ${packageVersion} <noreply@nosedive.dev>`,
	);
	assert.equal((message.match(new RegExp(`Feat: ${featId}`, "g")) ?? []).length, 1);
	assert.equal((message.match(new RegExp(`Dive: ${diveId}`, "g")) ?? []).length, 1);
	assert.equal(
		(message.match(new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern}`, "g")) ?? [])
			.length,
		1,
	);
	assert.equal(
		runTool("git", ["config", "--worktree", "--get", "core.hooksPath"], worktree).stdout.trim()
			.length > 0,
		true,
		"hook path should be configured in the worktree",
	);
	assert.equal(
		runGitUnchecked(["config", "--local", "--get", "core.hooksPath"], worktree).stdout.trim(),
		"",
		"hook path must not be written to shared repository config",
	);
});

test("jump push-isolates its hydrated worktree without breaking fetch", () => {
	const { bridge } = setup("push-isolation");
	const worktree = repoWorktree(bridge, "push-isolation");
	assertOk(run(["jump"], bridge), "jump failed");

	assert.equal(
		runTool(
			"git",
			["config", "--worktree", "--get", "remote.origin.pushurl"],
			worktree,
		).stdout.trim(),
		"nosedive-render-587d3f73-2534-5179-b111-ce6c83d6814d",
	);
	const blocked = runGitUnchecked(["push", "origin", "HEAD:refs/heads/agent"], worktree);
	assert.notEqual(blocked.status, 0, "an agent must not be able to push from a hydrated worktree");
	runTool("git", ["fetch", "origin"], worktree);
});

/**
 * npm's `prepare` lifecycle runs `git config core.hooksPath .githooks` inside
 * whatever worktree the agent is working in, which lands in the *shared*
 * repository config. The worktree override has to outrank it, and jump has to
 * clear the stale shared value it leaves behind.
 */
test("jump survives tooling that rewrites core.hooksPath in shared config", () => {
	const { bridge, featId, diveId } = setup("hooks-pollution");
	const worktree = repoWorktree(bridge, "hooks-pollution");
	assertOk(run(["jump"], bridge), "jump failed");
	const managedHooks = runTool(
		"git",
		["config", "--worktree", "--get", "core.hooksPath"],
		worktree,
	).stdout.trim();

	runTool("git", ["config", "core.hooksPath", ".githooks"], worktree);
	assert.equal(
		runTool("git", ["config", "--get", "core.hooksPath"], worktree).stdout.trim(),
		managedHooks,
		"the worktree override must outrank a shared-config write",
	);
	gitCommitEmpty(worktree, "commit after tooling ran");
	assert.match(
		runTool("git", ["log", "-1", "--format=%B"], worktree).stdout,
		new RegExp(`Feat: ${featId}`),
		"managed hooks must still fire after the shared config was rewritten",
	);

	// The commit above is unpublished, and jump refuses to move a worktree off
	// one; the pin has to follow it before the scope can be re-hydrated.
	repinByHand(bridge, diveId, ["hooks-pollution"]);
	assertOk(run(["jump"], bridge), "second jump failed");
	assert.equal(
		runGitUnchecked(["config", "--local", "--get", "core.hooksPath"], worktree).stdout.trim(),
		"",
		"jump should clear the stale shared-config hooksPath",
	);
	assert.equal(
		runTool("git", ["config", "--worktree", "--get", "core.hooksPath"], worktree).stdout.trim(),
		managedHooks,
		"re-running jump should not churn the managed hook path",
	);
});

test("jump chains a repo prepare-commit-msg hook without modifying tracked files", (t) => {
	const shell = posixShell();
	if (!shell) {
		t.skip("no POSIX shell found on PATH or alongside git; cannot run a shell hook fixture");
		return;
	}
	const { bridge, featId, diveId } = setup("foreign-hook");
	const worktree = repoWorktree(bridge, "foreign-hook");
	const foreignHooks = join(worktree, ".githooks");
	const foreignHook = join(foreignHooks, "prepare-commit-msg");
	const prePushHook = join(foreignHooks, "pre-push");
	write(foreignHook, "#!/bin/sh\nprintf 'Repo-Hook: ran\\n' >> \"$1\"\n");
	write(prePushHook, "#!/bin/sh\nprintf 'pre-push-ran\\n' > pre-push-ran\n");
	chmodSync(foreignHook, 0o755);
	chmodSync(prePushHook, 0o755);
	runTool("git", ["add", ".githooks"], worktree);
	gitCommit(worktree, "track repo hook");
	runTool("git", ["config", "extensions.worktreeConfig", "true"], worktree);
	runTool("git", ["config", "core.hooksPath", ".githooks"], worktree);
	// The fixture commit is unpublished, and jump refuses to move a worktree off
	// one; the pin follows it so the hook survives into the run under test.
	repinByHand(bridge, diveId, ["foreign-hook"]);

	const result = run(["jump"], bridge);
	assertOk(result, "jump failed with a foreign hook");
	assert.equal(
		readFileSync(foreignHook, "utf8"),
		"#!/bin/sh\nprintf 'Repo-Hook: ran\\n' >> \"$1\"\n",
	);
	gitCommitEmpty(worktree, "implementation");
	const message = runTool("git", ["log", "-1", "--format=%B"], worktree).stdout;
	assert.match(message, /Repo-Hook: ran/);
	assert.match(message, new RegExp(`Feat: ${featId}`));
	assert.match(message, new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern}`));
	const managedHooks = runTool(
		"git",
		["config", "--worktree", "--get", "core.hooksPath"],
		worktree,
	).stdout.trim();
	runTool(shell, [join(managedHooks, "pre-push")], worktree);
	assert.equal(readFileSync(join(worktree, "pre-push-ran"), "utf8"), "pre-push-ran\n");
	writeFileSync(join(worktree, "pre-push-ran"), "");
	runTool("git", ["clean", "-f", "pre-push-ran"], worktree);
	assert.equal(runTool("git", ["status", "--porcelain"], worktree).stdout, "");
});

test("jump preserves a failing repo prepare-commit-msg hook exit", () => {
	const { bridge, diveId } = setup("failing-hook");
	const worktree = repoWorktree(bridge, "failing-hook");
	const failingHook = join(worktree, ".githooks", "prepare-commit-msg");
	write(failingHook, "#!/bin/sh\nexit 23\n");
	chmodSync(failingHook, 0o755);
	runTool("git", ["add", ".githooks/prepare-commit-msg"], worktree);
	gitCommit(worktree, "track failing hook");
	runTool("git", ["config", "extensions.worktreeConfig", "true"], worktree);
	runTool("git", ["config", "core.hooksPath", ".githooks"], worktree);
	repinByHand(bridge, diveId, ["failing-hook"]);
	assertOk(run(["jump"], bridge), "jump failed");

	const head = runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim();
	const commit = runGitUnchecked(["commit", "--allow-empty", "-m", "must fail"], worktree);
	assert.notEqual(commit.status, 0);
	assert.equal(runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim(), head);
});

/**
 * Deliberately on the older `effort:` spelling of the opt-out. It is repo
 * config a pilot may already have set, so the fallback is a live promise and is
 * only proven while something exercises it. The canonical key is covered below.
 */
test("jump honors independent repo provenance opt-outs and still installs the wrapper", () => {
	const { bridge, repoId } = setup("opt-outs");
	const worktree = repoWorktree(bridge, "opt-outs");
	const repoDoc = join(bridge, "kb", `${repoId}.md`);
	writeFileSync(
		repoDoc,
		readFileSync(repoDoc, "utf8").replace(
			"  trunk: main\n",
			"  trunk: main\n  commit-provenance:\n    effort: false\n    co-author: false\n",
		),
	);
	assertOk(run(["jump"], bridge), "jump failed");
	gitCommitEmpty(worktree, "implementation");
	const message = runTool("git", ["log", "-1", "--format=%B"], worktree).stdout;
	assert.doesNotMatch(message, /Feat:/);
	assert.doesNotMatch(message, /Co-Authored-By: nosedive/);
	assert.notEqual(
		runTool("git", ["config", "--worktree", "--get", "core.hooksPath"], worktree).stdout.trim(),
		"",
	);
});

test("jump honors the canonical commit-provenance opt-out key", () => {
	const { bridge, repoId, diveId } = setup("feat-opt-out");
	const worktree = repoWorktree(bridge, "feat-opt-out");
	const repoDoc = join(bridge, "kb", `${repoId}.md`);
	writeFileSync(
		repoDoc,
		readFileSync(repoDoc, "utf8").replace(
			"  trunk: main\n",
			"  trunk: main\n  commit-provenance:\n    feat: false\n",
		),
	);
	assertOk(run(["jump"], bridge), "jump failed");
	gitCommitEmpty(worktree, "implementation");
	const message = runTool("git", ["log", "-1", "--format=%B"], worktree).stdout;
	assert.doesNotMatch(message, /Feat:/);
	// Only the feat trailer is opted out, so the others must survive.
	assert.match(message, new RegExp(`Dive: ${diveId}`));
	assert.match(message, /Co-Authored-By: nosedive/);
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
	assert.match(diveText, /diver: "jump@example\.test"/);
	assert.match(
		diveText,
		/^## jumped \d{4}-\d{2}-\d{2}T[\d:.]+Z\s*$/im,
		"a partial-success run still hydrated a usable workspace, so the section is still appended",
	);

	for (const suffix of ["a", "b", "c"]) {
		assert.equal(
			existsSync(join(bridge, "kb", `aaaaaaaa-1000-7000-8000-00000000000${suffix}.md`)),
			true,
			`un-applied memo ${suffix} should be left in place`,
		);
	}
});

/**
 * The pin is where hydration wants the worktree, so a worktree already there is
 * finished business. Proven off the per-worktree HEAD reflog rather than the
 * resulting sha: a `checkout --detach` back onto the commit HEAD already names
 * leaves the sha identical and the reflog one entry longer, and it is the
 * needless checkout -- which would discard nothing but would blow away an
 * in-progress bisect or a stale index -- that this forbids.
 */
test("jump leaves a worktree already detached at the pin untouched", () => {
	const { bridge, pinnedRef } = setup("at-pin");
	const worktree = repoWorktree(bridge, "at-pin");
	assert.equal(worktreeHead(bridge, "at-pin"), pinnedRef);
	const reflogBefore = runTool("git", ["reflog", "show", "HEAD"], worktree).stdout;

	const result = run(["jump"], bridge);
	assertOk(result, "jump failed on a worktree already at its pin");
	assert.equal(worktreeHead(bridge, "at-pin"), pinnedRef);
	assert.equal(
		runTool("git", ["reflog", "show", "HEAD"], worktree).stdout,
		reflogBefore,
		"jump must not run a checkout in a worktree already detached at the pin",
	);
	assert.doesNotMatch(result.stdout, /moved-from=/, "nothing moved, so nothing should say it did");
});

/**
 * The pack + repin case. `pack` leaves the worktree on the old pin and the
 * repin moves the pin forward, so the worktree is behind a commit origin
 * already has -- moving it loses nothing, and refusing here would stop the
 * pack -> repin -> jump flow dead.
 */
test("jump moves a clean worktree off a published commit onto the pin", () => {
	const { bridge, repoId, diveId, pinnedRef } = deckSetup("published-move", { claimed: false });
	const worktree = repoWorktree(bridge, "published-move");

	write(join(worktree, "published.txt"), "published\n");
	runTool("git", ["add", "published.txt"], worktree);
	gitCommit(worktree, "a commit some ref contains");
	const published = worktreeHead(bridge, "published-move");
	// A local branch is enough: the refusal asks whether any ref reaches HEAD,
	// not whether that ref is on a remote.
	runTool("git", ["branch", "fixture-published", published], worktree);

	const result = run(["jump", diveId], bridge);
	assertOk(result, "jump failed on a clean worktree at a published commit");
	assert.equal(
		worktreeHead(bridge, "published-move"),
		pinnedRef,
		"a published worktree should be moved back to the dive's pin",
	);
	assert.match(
		result.stdout,
		new RegExp(`hydrated repo=${repoId} path=\\S+ moved-from=${published}`),
		"jump should say which commit it moved the worktree off",
	);
	assert.equal(existsSync(join(worktree, "published.txt")), false);
	assert.match(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
		new RegExp(`repo=published-move-repo path=\\S+ work-branch=\\S+ ref=${pinnedRef}`),
	);
});

test("jump refuses a worktree carrying a commit no ref contains", () => {
	const { bridge, diveId, pinnedRef } = setup("unpublished");
	const worktree = repoWorktree(bridge, "unpublished");

	write(join(worktree, "unpublished.txt"), "mine\n");
	runTool("git", ["add", "unpublished.txt"], worktree);
	gitCommit(worktree, "a commit no ref contains");
	const unpublished = worktreeHead(bridge, "unpublished");

	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump unexpectedly moved off an unpublished commit");
	assert.match(result.stderr, /repo=unpublished-repo/);
	assert.match(result.stderr, /path=workspace\/unpublished-repo/);
	assert.match(result.stderr, new RegExp(`head=${unpublished}`));
	assert.match(result.stderr, new RegExp(`pin=${pinnedRef}`));
	assert.match(result.stderr, /kb\/019fcb35-d660-7318-ac4c-3d5aeed3a81e/);
	assert.equal(
		worktreeHead(bridge, "unpublished"),
		unpublished,
		"a refused jump must leave the worktree on the commit it refused to leave",
	);
	assert.equal(readFileSync(join(worktree, "unpublished.txt"), "utf8"), "mine\n");
	assert.doesNotMatch(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
		/^## jumped /im,
		"a refused run never hydrates, so nothing should be appended",
	);
});

/**
 * A refusal that has already relocated one of two worktrees is not a refusal,
 * so every scope is evaluated before any of them is touched -- and the pilot is
 * told about all of them at once rather than one re-run at a time.
 */
test("jump reports every unmovable scope in one message and moves none of them", () => {
	const { bridge, scopeNames } = setup("batch-refusal", { repos: 2 });
	const heads = [];
	for (const scopeName of scopeNames) {
		const worktree = repoWorktree(bridge, scopeName);
		write(join(worktree, "unpublished.txt"), "mine\n");
		runTool("git", ["add", "unpublished.txt"], worktree);
		gitCommit(worktree, `a commit no ref contains in ${scopeName}`);
		heads.push(worktreeHead(bridge, scopeName));
	}

	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump unexpectedly accepted two unpublished worktrees");
	for (const [index, scopeName] of scopeNames.entries()) {
		assert.match(result.stderr, new RegExp(`repo=${scopeName}-repo`));
		assert.match(result.stderr, new RegExp(`head=${heads[index]}`));
		assert.equal(
			worktreeHead(bridge, scopeName),
			heads[index],
			`${scopeName} moved despite the run being refused`,
		);
	}
	assert.equal(
		(result.stderr.match(/^nosedive: refusing/gm) ?? []).length,
		1,
		"both scopes belong to one refusal, not one run each",
	);
});

/**
 * A `ref:` naming a branch is a moving target, so a section recording the
 * string records nothing a month later. Hydration already resolved the commit;
 * the section writes that.
 */
test("jump records the commit a branch ref resolved to, not the branch name", () => {
	const { bridge, repoId, diveId, pinnedRef } = deckSetup("branch-ref", { claimed: false });
	const divePath = join(bridge, "kb", `${diveId}.md`);
	writeFileSync(divePath, readFileSync(divePath, "utf8").replace(/^(\s+)ref: .*$/m, "$1ref: main"));
	assertOk(run(["dehydrate-repo.workspace", repoId, "--force"], bridge), "dehydrate failed");

	const result = run(["jump", diveId], bridge);
	assertOk(result, "jump failed on a scope pinned to a branch");
	const diveText = readFileSync(divePath, "utf8");
	assert.match(
		diveText,
		new RegExp(`repo=branch-ref-repo path=\\S+ work-branch=\\S+ ref=${pinnedRef}`),
		"the jumped section should carry the resolved commit",
	);
	assert.doesNotMatch(diveText, /^- repo=\S+ .*ref=main$/m, "the branch name is not a record");
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

	const diveTextAfter = readFileSync(join(kbDir, `${diveId}.md`), "utf8");
	assert.doesNotMatch(
		diveTextAfter,
		/^##\s+\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*$/m,
		"a total-failure run never reaches the commit, so nothing should be appended",
	);
});

// --- choosing a dive --------------------------------------------------------
//
// `jump` picks the dive up as well as unpacking it, so it needs the same answer
// to "may this pilot take this dive" that preflight prints. That answer is the
// backlog walk, and a bridge with no deck reaches no dive at all -- so these
// fixtures configure a backlog memo, which the fixtures above deliberately do
// not, and which is why they exercise only the marker path.

const BACKLOG_ID = "019fcf10-0000-7000-8000-0000000000b1";

/** The `setup` bridge with a backlog memo above its feat, so its dives are reachable. */
function deckSetup(name, { claimed = true } = {}) {
	const fixture = setup(name);
	const { bridge, featId, diveId } = fixture;
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: BACKLOG_ID });
	write(
		join(bridge, "kb", `${BACKLOG_ID}.md`),
		`---
kind: memo
id: ${BACKLOG_ID}
name: jump-test-backlog
gist: "Jump test backlog"
links:
  - kb/${featId}.md:
      rel: child.feat
---

# Backlog
`,
	);
	if (!claimed) unclaim(bridge, diveId);
	commitBridge(bridge, "add the backlog deck");
	return fixture;
}

/** Frees a dive and takes it off deck, which is the state a pilot picks one up from. */
function unclaim(bridge, diveId) {
	const divePath = join(bridge, "kb", `${diveId}.md`);
	writeFileSync(divePath, readFileSync(divePath, "utf8").replace(/^ {2}diver: .*\n/m, ""));
	rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });
}

function setDiver(bridge, diveId, email) {
	const divePath = join(bridge, "kb", `${diveId}.md`);
	const text = readFileSync(divePath, "utf8");
	writeFileSync(
		divePath,
		/^ {2}diver: .*$/m.test(text)
			? text.replace(/^ {2}diver: .*$/m, `  diver: ${email}`)
			: text.replace(/^meta:$/m, `meta:\n  diver: ${email}`),
	);
}

function commitBridge(bridge, message) {
	runTool("git", ["add", "-A"], bridge);
	gitCommit(bridge, message);
	runTool("git", ["push"], bridge);
}

/** A second, unheld dive on the same feat -- the thing a selection has to choose between. */
function freeDive(bridge, featId, gist) {
	const result = run(
		["record.dive", "--feat", featId, "--gist", gist, "--brief", "Test brief."],
		bridge,
	);
	assertOk(result, "record.dive failed");
	const id = /^Recorded kb[\/]([0-9a-f-]{36})\.md$/m.exec(result.stdout)?.[1];
	assert.ok(id, `record.dive did not report a dive id:\n${result.stdout}`);
	return id;
}

function jumpedSection(bridge, diveId) {
	const text = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const match = /^## jumped [^\n]*\n\n([\s\S]*)$/im.exec(text);
	assert.ok(match, `dive doc carries no jumped section:\n${text}`);
	return match[1].trim();
}

function jumpedSectionCount(text) {
	return (text.match(/^## Jumped /gim) ?? []).length;
}

test("bare jump with nothing on deck lists the dives that could be jumped", () => {
	const { bridge, diveId } = deckSetup("deck-list", { claimed: false });

	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump with nothing on deck unexpectedly succeeded");
	assert.match(result.stderr, /no dive is on deck/);
	assert.match(result.stderr, /jump <dive-doc-path>/);
	assert.ok(
		result.stderr.includes("## [Jump Test](kb/"),
		`the eligible dives should be grouped under their feat heading:\n${result.stderr}`,
	);
	assert.match(result.stderr, new RegExp(`- kb/${diveId}\\.md: Working on Jump Test\\.`));
	assert.doesNotMatch(
		result.stderr,
		/\n\s+- \[/,
		"dive options should not be nested under feat names",
	);
});

test("bare jump with nothing to pick up says so rather than printing an empty list", () => {
	const { bridge, diveId } = deckSetup("deck-empty");
	setDiver(bridge, diveId, "someone-else@example.test");
	rmSync(join(bridge, "workspace", ".nosedive-ref"));
	commitBridge(bridge, "hand the only dive to another pilot");

	const result = run(["jump"], bridge);
	assert.notEqual(result.status, 0, "jump with no eligible dive unexpectedly succeeded");
	assert.match(result.stderr, /no dive is available to pick up/);
	assert.match(result.stderr, /record\.dive/);
	assert.doesNotMatch(result.stderr, /\(none\)/, "an empty list is not an answer");
	assert.doesNotMatch(result.stderr, /nosedive-error:/);
});

test("the jumped section names the pilot and their email, and its repo lines are unchanged", () => {
	const { bridge, diveId, pinnedRef, scopeNames } = deckSetup("deck-lead", { claimed: false });

	assertOk(run(["jump", diveId], bridge), "jump failed to claim the dive");

	const section = jumpedSection(bridge, diveId);
	assert.equal(
		section,
		`Jump Test <jump@example.test> picked up jump-test.nosedive, hydrating 1 scoped repo.\n\n` +
			`- repo=${scopeNames[0]}-repo path=workspace/${scopeNames[0]}-repo` +
			` work-branch=work/jump-test.nosedive ref=${pinnedRef}`,
	);
});

test("jump refuses a dive held by another diver and names takeover", () => {
	const { bridge, repoId, diveId } = deckSetup("deck-other");
	setDiver(bridge, diveId, "someone-else@example.test");
	assertOk(run(["dehydrate-repo.workspace", repoId, "--force"], bridge), "dehydrate failed");
	commitBridge(bridge, "hand the dive to another pilot");
	const before = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const beforeHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	const bare = run(["jump"], bridge);
	assert.notEqual(bare.status, 0, "bare jump accepted a dive held by another diver");
	assert.match(bare.stderr, /held by someone-else@example\.test/);
	assert.match(bare.stderr, new RegExp(`record\\.dive --ref ${diveId} --takeover`));
	assert.equal(
		existsSync(repoWorktree(bridge, "deck-other")),
		false,
		"refusal must precede hydration",
	);

	rmSync(join(bridge, "workspace", ".nosedive-ref"));
	const explicit = run(["jump", diveId], bridge);
	assert.notEqual(explicit.status, 0, "explicit jump accepted a dive held by another diver");
	assert.match(explicit.stderr, /held by someone-else@example\.test/);
	assert.match(explicit.stderr, new RegExp(`record\\.dive --ref ${diveId} --takeover`));

	const after = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.equal(jumpedSectionCount(after), jumpedSectionCount(before));
	assert.equal(runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(), beforeHead);
	assert.equal(
		existsSync(repoWorktree(bridge, "deck-other")),
		false,
		"explicit refusal must precede hydration",
	);
});

test("jump <dive-ref> claims the dive it picks up and commits the claim", () => {
	const { bridge, diveId } = deckSetup("deck-claim", { claimed: false });

	const result = run(["jump", diveId], bridge);
	assertOk(result, "jump <dive-ref> failed on an unheld dive");

	assert.match(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
		/^ {2}diver: jump@example\.test$/m,
		"the claim is meta.diver, as the pilot's email",
	);
	assert.equal(
		readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8").trim(),
		`id: ${diveId}`,
	);
	assert.match(
		runTool("git", ["show", "--name-only", "--format=", "HEAD"], bridge).stdout,
		new RegExp(`kb/${diveId}\.md`),
		"the claim rides the commit jump already makes",
	);
	assert.equal(
		runTool("git", ["status", "--porcelain", "--", `kb/${diveId}.md`], bridge).stdout.trim(),
		"",
		"the claimed dive doc should be left committed, not as bridge WIP",
	);
});

test("bare jump claims an unheld dive already marked on deck", () => {
	const { bridge, diveId } = deckSetup("deck-bare-claim");
	setDiver(bridge, diveId, "null");
	commitBridge(bridge, "release the marked dive");

	assertOk(run(["jump"], bridge), "bare jump failed to claim the marked dive");

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.match(diveText, /^ {2}diver: jump@example\.test$/m);
	assert.equal(jumpedSectionCount(diveText), 1);
	assert.match(
		runTool("git", ["show", "--name-only", "--format=", "HEAD"], bridge).stdout,
		new RegExp(`kb/${diveId}\\.md`),
	);
});

/**
 * `meta.packer` records who put the dive down last, so it is only true of a
 * dive nobody holds. Picking the dive up ends that, and leaving the field
 * behind would have the document name a holder and a releaser at once.
 */
test("jump <dive-ref> clears the packer of the dive it picks up", () => {
	const { bridge, diveId } = deckSetup("deck-packer", { claimed: false });
	const divePath = join(bridge, "kb", `${diveId}.md`);
	writeFileSync(
		divePath,
		readFileSync(divePath, "utf8").replace(/^meta:$/m, "meta:\n  packer: earlier@example.test"),
	);
	commitBridge(bridge, "record who packed the dive");

	assertOk(run(["jump", diveId], bridge), "jump <dive-ref> failed on a packed dive");
	const jumped = readFileSync(divePath, "utf8");
	assert.match(jumped, /^ {2}diver: jump@example\.test$/m);
	assert.doesNotMatch(jumped, /^ {2}packer:/m, "picking a dive up ends who packed it");
});

test("jump <dive-ref> refuses a foreign-held dive with takeover rather than alternatives", () => {
	const { bridge, featId, diveId } = deckSetup("deck-ineligible", { claimed: false });
	const held = freeDive(bridge, featId, "A dive somebody else is flying");
	setDiver(bridge, held, "someone-else@example.test");
	commitBridge(bridge, "add a dive another pilot holds");

	const result = run(["jump", held], bridge);
	assert.notEqual(result.status, 0, "jump unexpectedly accepted a dive held by another pilot");
	assert.match(result.stderr, new RegExp(`dive ${held} is held by someone-else@example\\.test`));
	assert.match(result.stderr, new RegExp(`record\\.dive --ref ${held} --takeover`));
	assert.doesNotMatch(
		result.stderr,
		new RegExp(`kb/${diveId}\\.md`),
		"a known foreign holder should name takeover instead of unrelated alternatives",
	);
});

test("jump <dive-ref> refuses when the workspace already holds a different dive", () => {
	const { bridge, featId, diveId } = deckSetup("deck-held");
	const other = freeDive(bridge, featId, "A dive that is not on deck");
	commitBridge(bridge, "add a second dive");

	const result = run(["jump", other], bridge);
	assert.notEqual(result.status, 0, "jump unexpectedly swapped the dive on deck");
	assert.match(result.stderr, new RegExp(`already has active dive ${diveId}`));
	assert.equal(
		readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8").trim(),
		`id: ${diveId}`,
		"a refused jump leaves the deck as it stands",
	);
});

test("jump <dive-ref> records the first jump of a same-pilot planned dive", () => {
	const { bridge, diveId } = deckSetup("deck-rejump");
	const before = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const beforeHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	assertOk(run(["jump", diveId], bridge), "jump <dive-ref> failed on the dive already on deck");
	const after = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.equal(
		jumpedSectionCount(after),
		jumpedSectionCount(before) + 1,
		"the first jump should append one log section",
	);
	assert.notEqual(runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(), beforeHead);
});

test("repeated explicit jumps on a recent same-pilot dive remain idempotent", () => {
	const { bridge, diveId } = deckSetup("deck-explicit-clean");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	const before = readFileSync(divePath, "utf8");
	assert.equal(jumpedSectionCount(before), 0, "fixture should start without a jump log");
	const beforeHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	assertOk(run(["jump", diveId], bridge), "explicit jump failed on a same-pilot dive");
	const firstJumpHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();
	assertOk(run(["jump", diveId], bridge), "repeated explicit jump failed");

	const after = readFileSync(divePath, "utf8");
	assert.equal(
		jumpedSectionCount(after),
		1,
		"the first same-pilot jump should append a log section",
	);
	assert.notEqual(firstJumpHead, beforeHead);
	assert.equal(runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(), firstJumpHead);
	assert.equal(runTool("git", ["status", "--porcelain", "--", "kb"], bridge).stdout.trim(), "");
	assert.equal(
		readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8").trim(),
		`id: ${diveId}`,
	);
});

test("jump records another claim when the latest log is more than four hours old", () => {
	const { bridge, diveId } = deckSetup("deck-stale-log");
	const divePath = join(bridge, "kb", `${diveId}.md`);

	assertOk(run(["jump"], bridge), "first bare jump failed");
	const oldStamp = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
	writeFileSync(
		divePath,
		readFileSync(divePath, "utf8").replace(/^## jumped .*$/im, `## Jumped ${oldStamp}`),
	);
	commitBridge(bridge, "age the latest dive log");
	const staleHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	assertOk(run(["jump"], bridge), "jump failed to refresh a stale claim");

	assert.equal(jumpedSectionCount(readFileSync(divePath, "utf8")), 2);
	assert.notEqual(runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(), staleHead);
});

test("repeated bare jumps on the same-pilot dive remain idempotent", () => {
	const { bridge, diveId } = deckSetup("deck-bare-repeat");

	assertOk(run(["jump"], bridge), "first bare jump failed");
	const firstJumpHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();
	assertOk(run(["jump"], bridge), "second bare jump failed");

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.equal(
		jumpedSectionCount(diveText),
		1,
		"repeated hydration should append only the first jump log section",
	);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(),
		firstJumpHead,
		"the second hydration should not create a bridge commit",
	);
});
