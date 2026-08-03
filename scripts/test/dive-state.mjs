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
const tmp = createTmp("dive-state");
const noBridge = createNoBridge(tmp);

test("dive-state", () => {
	const wipBridge = join(tmp, "wip-bridge");
	const scopedRepo = join(wipBridge, "workspace", "scoped");
	const readonlyScopedRepo = join(wipBridge, "workspace", "readonly-scoped");
	const unscopedRepo = join(wipBridge, "workspace", "unscoped");
	const scopedRepoId = "019f9f96-0000-7000-8000-000000000001";
	const readonlyScopedRepoId = "019f9f96-0000-7000-8000-000000000002";
	const unscopedRepoId = "019f9f96-0000-7000-8000-000000000003";
	const activeDiveId = "019f9f96-0000-7000-8000-000000000010";
	mkdirSync(join(wipBridge, "kb"), { recursive: true });
	mkdirSync(scopedRepo, { recursive: true });
	mkdirSync(readonlyScopedRepo, { recursive: true });
	mkdirSync(unscopedRepo, { recursive: true });
	runTool("git", ["init", "-b", "main"], wipBridge);
	runTool("git", ["init", "-b", "main"], scopedRepo);
	runTool("git", ["init", "-b", "main"], readonlyScopedRepo);
	runTool("git", ["init", "-b", "main"], unscopedRepo);
	write(join(scopedRepo, "file.txt"), "base\n");
	runTool("git", ["add", "file.txt"], scopedRepo);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"base",
		],
		scopedRepo,
	);
	const scopedBase = runTool("git", ["rev-parse", "HEAD"], scopedRepo).stdout.trim();
	write(join(readonlyScopedRepo, "file.txt"), "base\n");
	runTool("git", ["add", "file.txt"], readonlyScopedRepo);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"base",
		],
		readonlyScopedRepo,
	);
	const readonlyBase = runTool("git", ["rev-parse", "HEAD"], readonlyScopedRepo).stdout.trim();
	write(join(unscopedRepo, "file.txt"), "base\n");
	runTool("git", ["add", "file.txt"], unscopedRepo);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"base",
		],
		unscopedRepo,
	);
	writeBridgeConfig(wipBridge);
	write(
		join(wipBridge, "kb", `${scopedRepoId}.md`),
		`---
kind: repo
id: ${scopedRepoId}
name: scoped
gist: "Scoped repo"
meta:
  path: workspace/scoped
---
`,
	);
	write(
		join(wipBridge, "kb", `${readonlyScopedRepoId}.md`),
		`---
kind: repo
id: ${readonlyScopedRepoId}
name: readonly-scoped
gist: "Read-only scoped repo"
meta:
  path: workspace/readonly-scoped
---
`,
	);
	write(
		join(wipBridge, "kb", `${unscopedRepoId}.md`),
		`---
kind: repo
id: ${unscopedRepoId}
name: unscoped
gist: "Unscoped repo"
meta:
  path: workspace/unscoped
---
`,
	);
	write(
		join(wipBridge, "kb", `${activeDiveId}.md`),
		`---
kind: dive
id: ${activeDiveId}
name: wip-test
gist: "Dive WIP test"
scopes:
  - ${scopedRepoId}:
      ref: ${scopedBase}
      mode: rw
  - ${readonlyScopedRepoId}:
      ref: ${readonlyBase}
      mode: ro
---

# WIP test dive
`,
	);

	rmSync(join(wipBridge, "workspace", ".nosedive-ref"), { force: true });
	write(join(unscopedRepo, "untracked.txt"), "unscoped change\n");
	const noMarkerWip = run(
		["_pre-push.hook", "origin", "https://example.invalid/repo.git"],
		wipBridge,
		"stdin should be ignored\n",
	);
	assertOk(noMarkerWip, "pre-push.hook should pass without active dive marker");

	write(join(wipBridge, "workspace", ".nosedive-ref"), `id: ${activeDiveId}\n`);
	const unscopedOnlyWip = run(["_pre-push.hook"], wipBridge);
	assertOk(unscopedOnlyWip, "pre-push.hook should pass when only unscoped repo is dirty");

	write(join(scopedRepo, "dirty.txt"), "scoped dirty\n");
	const scopedDirty = run(["_pre-push.hook"], wipBridge);
	assert.equal(scopedDirty.status, 1);
	assert.match(scopedDirty.stderr, /active dive has not been handed off/);
	assert.match(scopedDirty.stderr, new RegExp(`scoped repo ${scopedRepoId}`));
	assert.match(scopedDirty.stderr, /dirty worktree/);
	assert.match(scopedDirty.stderr, new RegExp(`Handoff runbook: ${handoffRunbookId}`));
	assert.match(scopedDirty.stderr, new RegExp(`npx nosedive render ${handoffRunbookId}`));
	rmSync(join(scopedRepo, "dirty.txt"));

	write(join(scopedRepo, "ahead.txt"), "ahead\n");
	runTool("git", ["add", "ahead.txt"], scopedRepo);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=nosedive@example.invalid",
			"commit",
			"-m",
			"ahead",
		],
		scopedRepo,
	);
	const scopedAhead = run(["_pre-push.hook"], wipBridge);
	assert.equal(scopedAhead.status, 1);
	assert.match(scopedAhead.stderr, /commits ahead of pinned ref/);
	runTool("git", ["reset", "--hard", scopedBase], scopedRepo);

	write(join(readonlyScopedRepo, "readonly-dirty.txt"), "readonly dirty\n");
	const readonlyDirty = run(["_pre-push.hook"], wipBridge);
	assert.equal(readonlyDirty.status, 1);
	assert.match(readonlyDirty.stderr, new RegExp(`read-only scoped repo ${readonlyScopedRepoId}`));
	assert.match(readonlyDirty.stderr, /consider re-scoping it writable/);
	rmSync(join(readonlyScopedRepo, "readonly-dirty.txt"));

	const pristineDive = run(["_pre-push.hook"], wipBridge);
	assertOk(pristineDive, "pre-push.hook should pass when active dive scoped repos are pristine");

	write(
		join(wipBridge, "workspace", ".nosedive-ref"),
		"id: 019f9f96-0000-7000-8000-000000009999\n",
	);
	const brokenMarker = run(["_pre-push.hook"], wipBridge);
	assert.equal(brokenMarker.status, 1);
	assert.match(brokenMarker.stderr, /broken active dive marker/);
	assert.match(brokenMarker.stderr, /no kind: dive doc found/);
});
