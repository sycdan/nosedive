import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
	assertContainsPath,
	assertGeneratedFrontmatter,
	assertOk,
	cli,
	createNoBridge,
	createTmp,
	escapeRegExp,
	gitCommit,
	gitCommonDir,
	handoffRunbookId,
	lib,
	libUrl,
	packageFoundationDocs,
	packageMigrationDoc,
	packageMigrationScript,
	packageNonFoundationDoc,
	root,
	run,
	runGit,
	runGitUnchecked,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const { readNosediveRc } = await import(libUrl);
const tmp = createTmp("prove");
const noBridge = createNoBridge(tmp);

test("prove", () => {
	const proofBridge = join(tmp, "proof-bridge");
	const proofSource = join(tmp, "proof-source");
	const prehydrateSource = join(tmp, "prehydrate-source");
	const unreachableSource = join(tmp, "unreachable-source");
	const proofRepoId = "019fa101-0000-7000-8000-000000000001";
	const prehydrateRepoId = "019fa101-0000-7000-8000-000000000002";
	const unreachableRepoId = "019fa101-0000-7000-8000-000000000003";
	const proofAssertionId = "019fa101-0000-7000-8000-000000000010";
	const proofProverId = "019fa101-0000-7000-8000-000000000020";
	const missingCwdAssertionId = "019fa101-0000-7000-8000-000000000011";
	const missingCwdProverId = "019fa101-0000-7000-8000-000000000021";
	const outOfScopeAssertionId = "019fa101-0000-7000-8000-000000000012";
	const outOfScopeProverId = "019fa101-0000-7000-8000-000000000022";
	const bareUuidProverAssertionId = "019fa101-0000-7000-8000-000000000013";
	const prehydrateAssertionId = "019fa101-0000-7000-8000-000000000014";
	const prehydrateProverId = "019fa101-0000-7000-8000-000000000024";
	const unreachableAssertionId = "019fa101-0000-7000-8000-000000000015";
	const unreachableProverId = "019fa101-0000-7000-8000-000000000025";
	const proofAssertionGist =
		"Proof runner executes a bridge-owned prover while keeping this intentionally long assertion gist on one YAML frontmatter line after recording proof metadata.";
	mkdirSync(join(proofBridge, "kb", "artifacts"), { recursive: true });
	mkdirSync(proofSource, { recursive: true });
	mkdirSync(prehydrateSource, { recursive: true });
	mkdirSync(unreachableSource, { recursive: true });
	runTool("git", ["init", "-b", "main"], proofBridge);
	runTool("git", ["init", "-b", "main"], proofSource);
	runTool("git", ["init", "-b", "main"], prehydrateSource);
	runTool("git", ["init", "-b", "main"], unreachableSource);
	write(join(proofSource, "file.txt"), "proof input\n");
	runTool("git", ["add", "file.txt"], proofSource);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"proof input",
		],
		proofSource,
	);
	const proofCommit = runTool("git", ["rev-parse", "HEAD"], proofSource).stdout.trim();
	write(join(prehydrateSource, "file.txt"), "prehydrated input\n");
	runTool("git", ["add", "file.txt"], prehydrateSource);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"prehydrated input",
		],
		prehydrateSource,
	);
	const prehydrateCommit = runTool("git", ["rev-parse", "HEAD"], prehydrateSource).stdout.trim();
	write(join(unreachableSource, "file.txt"), "reachable pinned input\n");
	runTool("git", ["add", "file.txt"], unreachableSource);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"reachable pinned input",
		],
		unreachableSource,
	);
	const unreachableCommit = runTool("git", ["rev-parse", "HEAD"], unreachableSource).stdout.trim();
	writeBridgeConfig(proofBridge);
	write(join(proofBridge, ".gitignore"), [".nosedive/", ""].join("\n"));
	write(
		join(proofBridge, "kb", "proof-repo.md"),
		`---
kind: repo
id: ${proofRepoId}
name: proof-target
gist: "Proof target repo"
meta:
  path: workspace/proof-target
  remotes:
    local: "${proofSource.replaceAll("\\", "/")}"
---
`,
	);
	write(
		join(proofBridge, "kb", "prehydrate-repo.md"),
		`---
kind: repo
id: ${prehydrateRepoId}
name: prehydrate-target
gist: "Prehydrated proof target repo"
meta:
  path: workspace/prehydrated-target
  remotes:
    local: "${prehydrateSource.replaceAll("\\", "/")}"
---
`,
	);
	write(
		join(proofBridge, "kb", "unreachable-repo.md"),
		`---
kind: repo
id: ${unreachableRepoId}
name: unreachable-target
gist: "Unreachable proof target repo"
meta:
  path: workspace/unreachable-target
  remotes:
    local: "${unreachableSource.replaceAll("\\", "/")}"
---
`,
	);
	const proofAssertionPath = join(proofBridge, "kb", `${proofAssertionId}.md`);
	write(
		proofAssertionPath,
		`---
kind: assertion
id: ${proofAssertionId}
name: proof-runner-direct-cli
gist: "${proofAssertionGist}"
scopes:
  - ${proofRepoId}:
      mode: ro
      ref: ${proofCommit}
links:
  - kb/artifacts/${proofProverId}.mjs:
      rel: prover
meta: { parser-fixture: { nested: { values: [ { ok: true } ] } } }
---

# Proof runner direct CLI assertion
`,
	);
	write(proofAssertionPath, readFileSync(proofAssertionPath, "utf8").replaceAll("\n", "\r\n"));
	const proofProverPath = join(proofBridge, "kb", "artifacts", `${proofProverId}.mjs`);
	write(
		proofProverPath,
		`export async function prove(ctx) {
  const repo = await ctx.repos.mustGet("proof-target");
  const aliasRepo = await ctx.repos.require("proof-target");
  ctx.assert.equal(aliasRepo.root, repo.root);
  const input = await ctx.fs.readText(repo.resolve("file.txt"));
  ctx.assert.match(input, /proof input/);

  const sandbox = await ctx.sandbox.create(ctx.assertion.name);
  await ctx.exec("git", ["init", "-b", "main"], { cwd: sandbox.root });
  await ctx.exec("git", ["config", "user.email", "direct-cli@example.invalid"], { cwd: sandbox.root });
  await ctx.exec("git", ["config", "user.name", "Direct CLI"], { cwd: sandbox.root });
  await ctx.exec(process.execPath, [${JSON.stringify(cli)}, "seed", "--headless", "--file", "AGENTS.md"], { cwd: sandbox.root });
  await ctx.exec(process.execPath, [${JSON.stringify(cli)}, "preflight"], { cwd: sandbox.root });
  const hookPath = ctx.path.join(sandbox.root, ".git", "hooks", "pre-push");
  const expectedHook = ${JSON.stringify(`#!/bin/sh\n# nosedive-managed\nexec node ${cli.replaceAll("\\", "/")} _pre-push.hook "$@"\n`)};
  const hook = await ctx.fs.readText(hookPath);
  ctx.assert.equal(hook, expectedHook);
  ctx.log("direct cli preflight succeeded");
}
`,
	);
	write(
		join(proofBridge, "kb", `${prehydrateAssertionId}.md`),
		`---
kind: assertion
id: ${prehydrateAssertionId}
name: proof-runner-prehydrates-scoped-repos
gist: "Proof runner hydrates assertion-scoped repos before invoking the prover artifact."
scopes:
  - ${prehydrateRepoId}:
      mode: ro
      ref: ${prehydrateCommit}
links:
  - kb/artifacts/${prehydrateProverId}.mjs:
      rel: prover
---

# Prehydrate assertion
`,
	);
	write(
		join(proofBridge, "kb", "artifacts", `${prehydrateProverId}.mjs`),
		`export async function prove(ctx) {
  const input = await ctx.fs.readText(ctx.bridge.resolve("workspace/prehydrated-target/file.txt"));
  ctx.assert.match(input, /prehydrated input/);
  ctx.log("artifact saw prehydrated scoped repo");
}
`,
	);
	write(
		join(proofBridge, "kb", `${unreachableAssertionId}.md`),
		`---
kind: assertion
id: ${unreachableAssertionId}
name: proof-runner-rejects-unreachable-existing-scope
gist: "Proof runner rejects an existing scoped repo checkout that cannot reach the assertion pin."
scopes:
  - ${unreachableRepoId}:
      mode: ro
      ref: ${unreachableCommit}
links:
  - kb/artifacts/${unreachableProverId}.mjs:
      rel: prover
---

# Unreachable pin assertion
`,
	);
	write(
		join(proofBridge, "kb", "artifacts", `${unreachableProverId}.mjs`),
		`export async function prove(ctx) {
  ctx.log("unreachable artifact should not run");
}
`,
	);
	write(
		join(proofBridge, "kb", `${missingCwdAssertionId}.md`),
		`---
kind: assertion
id: ${missingCwdAssertionId}
name: proof-runner-requires-explicit-cwd
gist: "Proof runner rejects ambient cwd use."
links:
  - kb/artifacts/${missingCwdProverId}.mjs:
      rel: prover
---

# Missing cwd assertion
`,
	);
	write(
		join(proofBridge, "kb", "artifacts", `${missingCwdProverId}.mjs`),
		`export async function prove(ctx) {
  await ctx.exec("git", ["status"]);
}
`,
	);
	write(
		join(proofBridge, "kb", `${outOfScopeAssertionId}.md`),
		`---
kind: assertion
id: ${outOfScopeAssertionId}
name: proof-runner-rejects-out-of-scope-repo
gist: "Proof runner rejects repo access not named by assertion scopes."
links:
  - kb/artifacts/${outOfScopeProverId}.mjs:
      rel: prover
---

# Out-of-scope assertion
`,
	);
	write(
		join(proofBridge, "kb", "artifacts", `${outOfScopeProverId}.mjs`),
		`export async function prove(ctx) {
  await ctx.repos.require("proof-target");
}
`,
	);
	write(
		join(proofBridge, "kb", `${bareUuidProverAssertionId}.md`),
		`---
kind: assertion
id: ${bareUuidProverAssertionId}
name: proof-runner-rejects-bare-uuid-prover-link
gist: "Proof runner rejects bare UUID prover links."
links:
  - ${proofProverId}:
      rel: prover
---

# Bare UUID prover assertion
`,
	);
	runTool("git", ["add", ".gitignore", "kb"], proofBridge);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"proof bridge fixtures",
		],
		proofBridge,
	);

	const proofRun = run(["prove", proofAssertionId], proofBridge);
	assertOk(proofRun, "prove direct CLI assertion failed");
	assert.match(proofRun.stdout, /^Proving: proof-runner-direct-cli$/m);
	assert.doesNotMatch(proofRun.stdout, new RegExp(`Proving: .*${proofAssertionId}`));
	assert.doesNotMatch(proofRun.stdout, /Gist:/);
	assert.doesNotMatch(proofRun.stdout, /^exec cwd=/m);
	assert.match(proofRun.stdout, /direct cli preflight succeeded/);
	assert.equal(
		proofRun.stdout.indexOf("Proving:") < proofRun.stdout.indexOf("direct cli preflight succeeded"),
		true,
		"prove should print its start line before prover ctx.log output",
	);
	assert.match(proofRun.stdout, new RegExp(`Proof passed: ${proofAssertionId}`));
	assert.equal(existsSync(join(proofBridge, "workspace", "proof-target")), true);
	assert.doesNotMatch(
		readFileSync(proofAssertionPath, "utf8"),
		/last-run:/,
		"non-recorded proof should not edit the assertion",
	);

	const proofRunByRelativePath = run(["prove", `kb/${proofAssertionId}.md`], proofBridge);
	assertOk(proofRunByRelativePath, "prove bridge-relative assertion path failed");
	assert.match(proofRunByRelativePath.stdout, new RegExp(`Proof passed: ${proofAssertionId}`));

	const proofRunByAbsolutePath = run(["prove", proofAssertionPath], proofBridge);
	assertOk(proofRunByAbsolutePath, "prove absolute in-bridge assertion path failed");
	assert.match(proofRunByAbsolutePath.stdout, new RegExp(`Proof passed: ${proofAssertionId}`));

	const outsideAssertionPath = join(tmp, "outside-assertion.md");
	write(outsideAssertionPath, readFileSync(proofAssertionPath, "utf8"));
	const outsideAssertionProof = run(["prove", outsideAssertionPath], proofBridge);
	assert.notEqual(outsideAssertionProof.status, 0, "outside assertion path unexpectedly passed");
	assert.match(outsideAssertionProof.stderr, /assertion path resolves outside the bridge/);

	const prehydrateRun = run(["prove", prehydrateAssertionId], proofBridge);
	assertOk(prehydrateRun, "prove should prehydrate scoped repos before artifact execution");
	assert.match(prehydrateRun.stdout, /artifact saw prehydrated scoped repo/);
	assert.equal(
		existsSync(join(proofBridge, "workspace", "prehydrated-target", ".git")),
		true,
		"scoped repo should be hydrated even when the prover never requests it",
	);

	const unreachableInitialRun = run(["prove", unreachableAssertionId], proofBridge);
	assertOk(unreachableInitialRun, "unreachable fixture initial hydration failed");
	const unreachableTarget = join(proofBridge, "workspace", "unreachable-target");
	runTool("git", ["checkout", "--orphan", "unrelated-proof"], unreachableTarget);
	runTool("git", ["rm", "-r", "--force", "--quiet", "."], unreachableTarget);
	write(join(unreachableTarget, "unrelated.txt"), "unrelated\n");
	runTool("git", ["add", "-A"], unreachableTarget);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"unrelated proof head",
		],
		unreachableTarget,
	);
	const unreachableProof = run(["prove", unreachableAssertionId], proofBridge);
	assert.notEqual(
		unreachableProof.status,
		0,
		"unreachable existing scoped repo unexpectedly passed",
	);
	assert.match(unreachableProof.stderr, /pinned commit is not reachable from HEAD/);
	assert.doesNotMatch(unreachableProof.stdout, /unreachable artifact should not run/);

	const verboseProofRun = run(["prove", proofAssertionId, "--verbose"], proofBridge);
	assertOk(verboseProofRun, "prove --verbose direct CLI assertion failed");
	assert.match(
		verboseProofRun.stdout,
		new RegExp(`Proving: proof-runner-direct-cli \\(${proofAssertionId}\\)`),
	);
	assert.match(verboseProofRun.stdout, /^exec cwd=.* git init -b main$/m);
	assert.match(verboseProofRun.stdout, /^exec cwd=.* preflight$/m);
	assert.match(verboseProofRun.stdout, new RegExp(`Gist: ${escapeRegExp(proofAssertionGist)}`));
	assert.equal(
		verboseProofRun.stdout.indexOf("exec cwd=") < verboseProofRun.stdout.indexOf("Proof passed:"),
		true,
		"verbose exec lines should print during execution, before the proof result",
	);
	assert.equal(
		verboseProofRun.stdout.indexOf("Gist:") < verboseProofRun.stdout.indexOf("Proof passed:"),
		true,
		"verbose gist should print before the proof result",
	);

	write(join(proofBridge, "outside-untracked.txt"), "outside\n");
	const dirtyBridgeRecord = run(["prove", proofAssertionId, "--record"], proofBridge);
	assertOk(dirtyBridgeRecord, "record with an unrelated dirty bridge unexpectedly failed");
	assert.match(dirtyBridgeRecord.stdout, new RegExp(`Proof recorded: ${proofAssertionId}`));
	rmSync(join(proofBridge, "outside-untracked.txt"));

	const recordedAssertion = readFileSync(proofAssertionPath, "utf8");
	assert.match(recordedAssertion, /last-run:/);
	assert.match(recordedAssertion, /pass: true/);
	assert.match(recordedAssertion, /^meta:$/m);
	assert.doesNotMatch(recordedAssertion, /^meta: \{/m);
	assert.doesNotMatch(recordedAssertion, /prover-sha256/);
	assert.doesNotMatch(recordedAssertion, /\\r/);
	assert.match(recordedAssertion, new RegExp(`^gist: "${escapeRegExp(proofAssertionGist)}"$`, "m"));
	assert.match(recordedAssertion, new RegExp(`commits:\\n\\s+${proofRepoId}: ${proofCommit}`));
	assert.doesNotMatch(recordedAssertion, /inputs:/);
	assert.doesNotMatch(recordedAssertion, /last-proven:/);
	assert.doesNotMatch(recordedAssertion, /last-proven-commit/);

	const originalProver = readFileSync(proofProverPath, "utf8");
	write(proofProverPath, `${originalProver}\n// dirty prover fixture\n`);
	const dirtyProverRecord = run(["prove", proofAssertionId, "--record"], proofBridge);
	assert.notEqual(dirtyProverRecord.status, 0, "dirty prover record unexpectedly succeeded");
	assert.match(dirtyProverRecord.stderr, /prover has uncommitted changes/);
	write(proofProverPath, originalProver);

	write(join(proofBridge, "workspace", "proof-target", "ahead.txt"), "ahead\n");
	runTool("git", ["add", "ahead.txt"], join(proofBridge, "workspace", "proof-target"));
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"ahead proof target",
		],
		join(proofBridge, "workspace", "proof-target"),
	);
	const aheadProof = run(["prove", proofAssertionId], proofBridge);
	assertOk(aheadProof, "non-recorded proof should allow scoped repos ahead of the pin");
	assert.match(aheadProof.stderr, /WARNING: scoped repo .* is ahead of pinned commit/);

	write(join(proofBridge, "workspace", "proof-target", "dirty.txt"), "dirty\n");
	const dirtyExperimentalProof = run(["prove", proofAssertionId], proofBridge);
	assertOk(dirtyExperimentalProof, "non-recorded proof should allow dirty accessed repos");
	assert.match(dirtyExperimentalProof.stderr, /WARNING: scoped repo .* is dirty; continuing/);
	const dirtyRecordedProof = run(["prove", proofAssertionId, "--record"], proofBridge);
	assert.notEqual(dirtyRecordedProof.status, 0, "dirty recorded proof unexpectedly succeeded");
	assert.match(
		dirtyRecordedProof.stderr,
		/refusing to record proof because accessed repo\(s\) are dirty/,
	);
	assert.doesNotMatch(dirtyRecordedProof.stdout, /direct cli preflight succeeded/);

	const proofTarget = join(proofBridge, "workspace", "proof-target");
	const aheadCommit = runTool("git", ["rev-parse", "HEAD"], proofTarget).stdout.trim();

	rmSync(join(proofTarget, "dirty.txt"));
	const driftedRecord = run(["prove", proofAssertionId, "--record"], proofBridge);
	assert.notEqual(driftedRecord.status, 0, "drifted recorded proof unexpectedly succeeded");
	assert.match(
		driftedRecord.stderr,
		/refusing to record proof because scoped repo\(s\) have drifted off their pins/,
	);
	assert.match(driftedRecord.stderr, new RegExp(`is at ${aheadCommit}, pinned at ${proofCommit}`));
	assert.match(driftedRecord.stderr, /rerun with --rehydrate/);
	assert.doesNotMatch(driftedRecord.stdout, /direct cli preflight succeeded/);

	const bareForce = run(["prove", proofAssertionId, "--record", "--force"], proofBridge);
	assert.notEqual(bareForce.status, 0, "bare --force unexpectedly succeeded");
	assert.match(bareForce.stderr, /--force only widens the --rehydrate dirty guard/);

	const rehydrateWithoutRecord = run(["prove", proofAssertionId, "--rehydrate"], proofBridge);
	assertOk(rehydrateWithoutRecord, "--rehydrate without --record failed");
	assert.match(
		rehydrateWithoutRecord.stderr,
		/WARNING: rehydrated scoped repo .* to pinned commit/,
	);
	assert.match(rehydrateWithoutRecord.stdout, new RegExp(`Proof passed: ${proofAssertionId}`));
	assert.doesNotMatch(rehydrateWithoutRecord.stdout, /Proof recorded:/);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], proofTarget).stdout.trim(),
		proofCommit,
		"--rehydrate should land the worktree on the pin without --record",
	);

	runTool("git", ["checkout", "--detach", aheadCommit], proofTarget);
	write(join(proofTarget, "ahead.txt"), "locally modified\n");
	const rehydrateDirty = run(["prove", proofAssertionId, "--rehydrate"], proofBridge);
	assert.notEqual(rehydrateDirty.status, 0, "dirty --rehydrate unexpectedly succeeded");
	assert.match(rehydrateDirty.stderr, /refusing to rehydrate scoped repo .* uncommitted work/);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], proofTarget).stdout.trim(),
		aheadCommit,
		"refused --rehydrate should leave the worktree where it was",
	);

	const rehydrateForced = run(
		["prove", proofAssertionId, "--record", "--rehydrate", "--force"],
		proofBridge,
	);
	assertOk(rehydrateForced, "--rehydrate --force record failed");
	assert.match(rehydrateForced.stderr, /WARNING: rehydrated scoped repo .* to pinned commit/);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], proofTarget).stdout.trim(),
		proofCommit,
		"--rehydrate should land the worktree on the pin",
	);
	assert.equal(
		existsSync(join(proofTarget, "ahead.txt")),
		false,
		"--force should discard the tracked change and the commit that added it",
	);
	assert.match(
		readFileSync(proofAssertionPath, "utf8"),
		new RegExp(`commits:\\n\\s+${proofRepoId}: ${proofCommit}`),
	);

	const missingCwdProof = run(["prove", missingCwdAssertionId], proofBridge);
	assert.notEqual(missingCwdProof.status, 0, "missing cwd prover unexpectedly succeeded");
	assert.match(
		missingCwdProof.stderr,
		new RegExp(`Proof failed: proof-runner-requires-explicit-cwd \\(${missingCwdAssertionId}\\)`),
	);
	assert.match(missingCwdProof.stderr, /Reason: ctx\.exec requires options\.cwd/);
	assert.doesNotMatch(missingCwdProof.stderr, /nosedive: ctx\.exec requires options\.cwd/);

	const outOfScopeProof = run(["prove", outOfScopeAssertionId], proofBridge);
	assert.notEqual(outOfScopeProof.status, 0, "out-of-scope repo access unexpectedly succeeded");
	assert.match(
		outOfScopeProof.stderr,
		new RegExp(
			`Proof failed: proof-runner-rejects-out-of-scope-repo \\(${outOfScopeAssertionId}\\)`,
		),
	);
	assert.match(outOfScopeProof.stderr, /Reason: .*does not scope it/);
	assert.doesNotMatch(outOfScopeProof.stderr, /nosedive: .*does not scope it/);

	const bareUuidProverProof = run(["prove", bareUuidProverAssertionId], proofBridge);
	assert.notEqual(bareUuidProverProof.status, 0, "bare UUID prover link unexpectedly succeeded");
	assert.match(bareUuidProverProof.stderr, /repo-root relative path, not a bare UUID/);
});
