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
const tmp = createTmp("repo-workspace");
const noBridge = createNoBridge(tmp);

test("repo-workspace", () => {
	const hydrateBridge = join(tmp, "hydrate-bridge");
	const hydrateRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cd98";
	const fallbackRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cd99";
	const unsafeRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cd9a";
	const unresolvedRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cd9b";
	const otherRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cd9c";
	const emptyFailRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cd9d";
	const nameRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cd9e";
	const ambiguousRepoIdA = "019f8584-453f-79ea-9d53-5f1b20b4cd9f";
	const ambiguousRepoIdB = "019f8584-453f-79ea-9d53-5f1b20b4cda0";
	const staleWorktreeRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cda1";
	const staleCacheRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cda2";
	const trunkRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cda3";
	const defaultBranchRepoId = "019f8584-453f-79ea-9d53-5f1b20b4cda4";
	mkdirSync(join(hydrateBridge, "kb"), { recursive: true });
	mkdirSync(join(hydrateBridge, "workspace"), { recursive: true });
	mkdirSync(join(hydrateBridge, "repos", "cloud-source"), { recursive: true });
	mkdirSync(join(hydrateBridge, "repos", "source"), { recursive: true });
	mkdirSync(join(hydrateBridge, "repos", "master-source"), { recursive: true });
	mkdirSync(join(hydrateBridge, "repos", "source-empty-fail"), {
		recursive: true,
	});
	runTool("git", ["init", "-b", "main"], hydrateBridge);
	runTool("git", ["config", "user.email", "hydrate@example.invalid"], hydrateBridge);
	runTool("git", ["config", "user.name", "Hydrate Dev"], hydrateBridge);

	const cloudSourceRepo = join(hydrateBridge, "repos", "cloud-source");
	runTool("git", ["init", "-b", "main"], cloudSourceRepo);
	runTool("git", ["config", "user.email", "hydrate@example.invalid"], cloudSourceRepo);
	runTool("git", ["config", "user.name", "Hydrate Dev"], cloudSourceRepo);
	write(join(cloudSourceRepo, "README.md"), "cloud main\n");
	runTool("git", ["add", "README.md"], cloudSourceRepo);
	runTool("git", ["commit", "-m", "cloud main commit"], cloudSourceRepo);
	runTool("git", ["branch", "release/candidate"], cloudSourceRepo);
	runTool("git", ["checkout", "release/candidate"], cloudSourceRepo);
	write(join(cloudSourceRepo, "README.md"), "cloud release\n");
	runTool("git", ["commit", "-am", "cloud release commit"], cloudSourceRepo);
	runTool("git", ["checkout", "main"], cloudSourceRepo);

	const sourceRepo = join(hydrateBridge, "repos", "source");
	runTool("git", ["init", "-b", "main"], sourceRepo);
	runTool("git", ["config", "user.email", "hydrate@example.invalid"], sourceRepo);
	runTool("git", ["config", "user.name", "Hydrate Dev"], sourceRepo);
	write(join(sourceRepo, "README.md"), "local main\n");
	runTool("git", ["add", "README.md"], sourceRepo);
	runTool("git", ["commit", "-m", "local main commit"], sourceRepo);
	runTool("git", ["branch", "release/candidate"], sourceRepo);
	runTool("git", ["checkout", "release/candidate"], sourceRepo);
	write(join(sourceRepo, "README.md"), "local release\n");
	runTool("git", ["commit", "-am", "local release commit"], sourceRepo);
	runTool("git", ["checkout", "main"], sourceRepo);
	const cloudMainCommit = runTool(
		"git",
		["rev-parse", "main^{commit}"],
		cloudSourceRepo,
	).stdout.trim();
	const localMainCommit = runTool("git", ["rev-parse", "main^{commit}"], sourceRepo).stdout.trim();
	assert.notEqual(
		cloudMainCommit,
		localMainCommit,
		"cloud and local fixture repos should have distinct commits",
	);

	const masterSourceRepo = join(hydrateBridge, "repos", "master-source");
	runTool("git", ["init", "-b", "master"], masterSourceRepo);
	runTool("git", ["config", "user.email", "hydrate@example.invalid"], masterSourceRepo);
	runTool("git", ["config", "user.name", "Hydrate Dev"], masterSourceRepo);
	write(join(masterSourceRepo, "README.md"), "local master\n");
	runTool("git", ["add", "README.md"], masterSourceRepo);
	runTool("git", ["commit", "-m", "local master commit"], masterSourceRepo);
	const localMasterCommit = runTool(
		"git",
		["rev-parse", "master^{commit}"],
		masterSourceRepo,
	).stdout.trim();

	const emptyFailSourceRepo = join(hydrateBridge, "repos", "source-empty-fail");
	runTool("git", ["init", "-b", "main"], emptyFailSourceRepo);
	runTool("git", ["config", "user.email", "hydrate@example.invalid"], emptyFailSourceRepo);
	runTool("git", ["config", "user.name", "Hydrate Dev"], emptyFailSourceRepo);
	write(join(emptyFailSourceRepo, "README.md"), "empty fail source\n");
	runTool("git", ["add", "README.md"], emptyFailSourceRepo);
	runTool("git", ["commit", "-m", "main commit"], emptyFailSourceRepo);

	writeBridgeConfig(hydrateBridge, { backlog: "./backlog" });
	write(
		join(hydrateBridge, "kb", "repo-hydrate.md"),
		`---
kind: repo
id: ${hydrateRepoId}
name: hydrate
gist: "Hydrate repo test fixture"
meta:
  path: workspace/hydrated-target
  worktree-path: workspace/legacy-target
  remotes:
    cloud: repos/cloud-source
    local: repos/source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-fallback.md"),
		`---
kind: repo
id: ${fallbackRepoId}
name: fallback
gist: "Legacy path fallback fixture"
meta:
  worktree-path: workspace/fallback-target
  remotes:
    local: repos/source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-by-name.md"),
		`---
kind: repo
id: ${nameRepoId}
name: hydrate-by-name
gist: "Exact name hydrate fixture"
meta:
  path: workspace/name-target
  remotes:
    local: repos/source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-ambiguous-a.md"),
		`---
kind: repo
id: ${ambiguousRepoIdA}
name: duplicate-name
gist: "Ambiguous name fixture A"
meta:
  path: workspace/ambiguous-a
  remotes:
    local: repos/source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-ambiguous-b.md"),
		`---
kind: repo
id: ${ambiguousRepoIdB}
name: duplicate-name
gist: "Ambiguous name fixture B"
meta:
  path: workspace/ambiguous-b
  remotes:
    local: repos/source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-unsafe.md"),
		`---
kind: repo
id: ${unsafeRepoId}
name: unsafe
gist: "Unsafe path fixture"
meta:
  worktree-path: ../outside-target
  remotes:
    local: repos/source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-stale-worktree.md"),
		`---
kind: repo
id: ${staleWorktreeRepoId}
name: stale-worktree
gist: "Stale worktree registration fixture"
meta:
  path: workspace/stale-target
  remotes:
    local: repos/source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-stale-cache.md"),
		`---
kind: repo
id: ${staleCacheRepoId}
name: stale-cache
gist: "Stale cache fetch fixture"
meta:
  path: workspace/stale-cache-target
  remotes:
    cloud: repos/cloud-source
    local: repos/source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-trunk.md"),
		`---
kind: repo
id: ${trunkRepoId}
name: trunk
gist: "Trunk default ref fixture"
meta:
  path: workspace/trunk-target
  trunk: master
  remotes:
    local: repos/master-source
---
`,
	);
	write(
		join(hydrateBridge, "kb", "repo-default-branch.md"),
		`---
kind: repo
id: ${defaultBranchRepoId}
name: default-branch
gist: "Legacy default-branch ref fixture"
meta:
  path: workspace/default-branch-target
  default-branch: master
  remotes:
    local: repos/master-source
---
`,
	);

	const hydrateByName = run(["hydrate-repo.workspace", "hydrate-by-name"], hydrateBridge);
	assertOk(hydrateByName, "hydrate-repo.workspace exact name failed");
	assert.match(
		hydrateByName.stdout,
		new RegExp(
			`^created repo=${nameRepoId} path=workspace[\\\\/]name-target commit=[0-9a-f]{40}$`,
			"m",
		),
	);
	assert.equal(
		readFileSync(join(hydrateBridge, "workspace", "name-target", ".nosedive-ref"), "utf8"),
		`id: ${nameRepoId}\n`,
	);

	const hydrateTrunk = run(["hydrate-repo.workspace", trunkRepoId], hydrateBridge);
	assertOk(hydrateTrunk, "hydrate-repo.workspace trunk default failed");
	assert.equal(
		runTool(
			"git",
			["rev-parse", "HEAD"],
			join(hydrateBridge, "workspace", "trunk-target"),
		).stdout.trim(),
		localMasterCommit,
		"hydrate should default to meta.trunk when --at is omitted",
	);

	const hydrateDefaultBranch = run(["hydrate-repo.workspace", defaultBranchRepoId], hydrateBridge);
	assertOk(hydrateDefaultBranch, "hydrate-repo.workspace default-branch fallback failed");
	assert.equal(
		runTool(
			"git",
			["rev-parse", "HEAD"],
			join(hydrateBridge, "workspace", "default-branch-target"),
		).stdout.trim(),
		localMasterCommit,
		"hydrate should fall back to legacy meta.default-branch when --at is omitted",
	);

	const ambiguousName = run(["hydrate-repo.workspace", "duplicate-name"], hydrateBridge);
	assert.notEqual(ambiguousName.status, 0, "ambiguous repo name unexpectedly succeeded");
	assert.match(
		ambiguousName.stderr,
		new RegExp(
			`repo name is ambiguous: duplicate-name \\(${ambiguousRepoIdA}, ${ambiguousRepoIdB}\\)`,
		),
	);
	assert.equal(
		existsSync(join(hydrateBridge, "workspace", "ambiguous-a")),
		false,
		"ambiguous repo name should not create first matching target path",
	);
	assert.equal(
		existsSync(join(hydrateBridge, "workspace", "ambiguous-b")),
		false,
		"ambiguous repo name should not create second matching target path",
	);

	const hydrateCreated = run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assertOk(hydrateCreated, "hydrate-repo.workspace create failed");
	assert.match(
		hydrateCreated.stdout,
		new RegExp(
			`^created repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target commit=[0-9a-f]{40}$`,
			"m",
		),
	);
	assert.equal(
		existsSync(join(hydrateBridge, "workspace", "legacy-target")),
		false,
		"deprecated meta.worktree-path should not win over meta.path",
	);
	const hydratedMarkerPath = join(hydrateBridge, "workspace", "hydrated-target", ".nosedive-ref");
	const hydratedTarget = join(hydrateBridge, "workspace", "hydrated-target");
	assert.equal(readFileSync(hydratedMarkerPath, "utf8"), `id: ${hydrateRepoId}\n`);
	const hydratedStatus = runTool(
		"git",
		["status", "--short", "--untracked-files=all"],
		hydratedTarget,
	).stdout;
	assert.equal(hydratedStatus, "", "repo ownership marker should not dirty the hydrated worktree");
	const hydratedExcludePathRaw = runTool(
		"git",
		["rev-parse", "--git-path", "info/exclude"],
		hydratedTarget,
	).stdout.trim();
	const hydratedExcludePath = isAbsolute(hydratedExcludePathRaw)
		? hydratedExcludePathRaw
		: resolve(hydratedTarget, hydratedExcludePathRaw);
	const hydratedExcludeText = readFileSync(hydratedExcludePath, "utf8");
	assert.match(hydratedExcludeText, /# BEGIN nosedive-managed repo-marker exclude/);
	assert.match(hydratedExcludeText, /^\.nosedive-ref$/m);
	assert.match(hydratedExcludeText, /# END nosedive-managed repo-marker exclude/);
	const hydrateCache = join(hydrateBridge, ".nosedive", "cache", hydrateRepoId);
	const hydrateCacheOrigin = runTool(
		"git",
		["remote", "get-url", "origin"],
		hydrateCache,
	).stdout.trim();
	assert.equal(
		hydrateCacheOrigin,
		cloudSourceRepo,
		"managed cache should prefer meta.remotes.cloud over local",
	);
	assert.equal(
		gitCommonDir(join(hydrateBridge, "workspace", "hydrated-target")),
		realpathSync(hydrateCache),
		"hydrated worktree should be attached to the managed cache",
	);
	assert.notEqual(
		gitCommonDir(join(hydrateBridge, "workspace", "hydrated-target")),
		gitCommonDir(sourceRepo),
		"hydrated worktree should not be attached directly to meta.remotes.local",
	);
	const hydratedHeadAfterCreate = runTool(
		"git",
		["rev-parse", "HEAD"],
		join(hydrateBridge, "workspace", "hydrated-target"),
	).stdout.trim();
	assert.equal(
		hydratedHeadAfterCreate,
		cloudMainCommit,
		"hydrated worktree should resolve default ref from the cloud-backed cache",
	);

	const staleCacheTarget = join(hydrateBridge, "workspace", "stale-cache-target");
	const staleManagedCache = join(hydrateBridge, ".nosedive", "cache", staleCacheRepoId);
	mkdirSync(dirname(staleManagedCache), { recursive: true });
	runTool("git", ["clone", "--bare", sourceRepo, staleManagedCache], hydrateBridge);
	runGitUnchecked(["config", "--unset-all", "remote.origin.fetch"], staleManagedCache);
	runTool("git", ["branch", "local/work", localMainCommit], staleManagedCache);
	assert.equal(
		runTool("git", ["rev-parse", "main^{commit}"], staleManagedCache).stdout.trim(),
		localMainCommit,
		"stale cache fixture should start behind the cloud source",
	);
	assert.notEqual(
		runGitUnchecked(["config", "--get-all", "remote.origin.fetch"], staleManagedCache).status,
		0,
		"stale cache fixture should start without a fetch refspec",
	);
	const staleCacheHydrate = run(["hydrate-repo.workspace", staleCacheRepoId], hydrateBridge);
	assertOk(
		staleCacheHydrate,
		"hydrate-repo.workspace should repair and fetch stale managed cache refs",
	);
	assert.match(
		staleCacheHydrate.stdout,
		new RegExp(
			`^created repo=${staleCacheRepoId} path=workspace[\\\\/]stale-cache-target commit=${cloudMainCommit}$`,
			"m",
		),
	);
	assert.equal(
		runTool("git", ["config", "--get-all", "remote.origin.fetch"], staleManagedCache).stdout.trim(),
		"+refs/heads/*:refs/remotes/origin/*",
		"hydrate should repair the managed cache fetch refspec",
	);
	assert.equal(
		runTool("git", ["remote", "get-url", "origin"], staleManagedCache).stdout.trim(),
		cloudSourceRepo,
		"hydrate should keep the managed cache pointed at the cloud remote",
	);
	assert.equal(
		runTool(
			"git",
			["rev-parse", "refs/remotes/origin/main^{commit}"],
			staleManagedCache,
		).stdout.trim(),
		cloudMainCommit,
		"hydrate should fetch cloud main into the managed cache remote-tracking refs before resolving refs",
	);
	assert.equal(
		runTool("git", ["rev-parse", "main^{commit}"], staleManagedCache).stdout.trim(),
		localMainCommit,
		"hydrate should not overwrite local cache branches when fetching cloud refs",
	);
	assert.equal(
		runTool("git", ["rev-parse", "local/work^{commit}"], staleManagedCache).stdout.trim(),
		localMainCommit,
		"hydrate fetch pruning should not delete local cache work branches",
	);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], staleCacheTarget).stdout.trim(),
		cloudMainCommit,
		"hydrate should create the worktree at the fetched cloud main commit",
	);

	const detachedAfterCreate = runGitUnchecked(
		["symbolic-ref", "-q", "HEAD"],
		join(hydrateBridge, "workspace", "hydrated-target"),
	);
	assert.notEqual(detachedAfterCreate.status, 0, "hydrated worktree should be detached");
	const peerWorktree = join(hydrateBridge, "workspace", "hydrated-peer");
	runTool("git", ["worktree", "add", "--detach", peerWorktree, cloudMainCommit], hydrateCache);

	const hydrateNoop = run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assertOk(hydrateNoop, "hydrate-repo.workspace noop failed");
	assert.match(
		hydrateNoop.stdout,
		new RegExp(
			`^noop repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target commit=[0-9a-f]{40}$`,
			"m",
		),
	);

	const hydrateReadOnly = run(
		["hydrate-repo.workspace", hydrateRepoId, "--read-only"],
		hydrateBridge,
	);
	assertOk(hydrateReadOnly, "hydrate-repo.workspace read-only hardening failed");
	assert.match(
		hydrateReadOnly.stdout,
		new RegExp(
			`^updated repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target commit=[0-9a-f]{40}$`,
			"m",
		),
	);
	const pushUrlReadOnly = runTool(
		"git",
		["config", "--worktree", "--get", "remote.origin.pushurl"],
		join(hydrateBridge, "workspace", "hydrated-target"),
	).stdout.trim();
	assert.equal(pushUrlReadOnly, "no_push://disabled");
	const pushUrlReadOnlyFromOrdinaryConfig = runGitUnchecked(
		["config", "--get", "remote.origin.pushurl"],
		join(hydrateBridge, "workspace", "hydrated-target"),
	);
	assert.equal(
		pushUrlReadOnlyFromOrdinaryConfig.stdout.trim(),
		"no_push://disabled",
		"effective pushurl should still block pushes from the hydrated worktree",
	);
	const sharedCachePushUrlReadOnly = runGitUnchecked(
		["config", "--get", "remote.origin.pushurl"],
		hydrateCache,
	);
	assert.notEqual(
		sharedCachePushUrlReadOnly.status,
		0,
		"read-only hardening should not write pushurl into shared cache config",
	);
	const peerPushUrlReadOnly = runGitUnchecked(
		["config", "--get", "remote.origin.pushurl"],
		peerWorktree,
	);
	assert.notEqual(
		peerPushUrlReadOnly.status,
		0,
		"read-only hardening should not affect sibling worktrees",
	);
	const peerStillWorktree = runTool(
		"git",
		["rev-parse", "--is-inside-work-tree"],
		peerWorktree,
	).stdout.trim();
	assert.equal(
		peerStillWorktree,
		"true",
		"enabling worktree-local config should not make sibling worktrees look bare",
	);
	const worktreeConfigEnabled = runTool(
		"git",
		["config", "--get", "extensions.worktreeConfig"],
		hydrateCache,
	).stdout.trim();
	assert.equal(
		worktreeConfigEnabled,
		"true",
		"read-only hardening should enable Git worktree-local config",
	);

	const hydrateWritableRestore = run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assertOk(hydrateWritableRestore, "hydrate-repo.workspace writable restore failed");
	assert.match(
		hydrateWritableRestore.stdout,
		new RegExp(
			`^updated repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target commit=[0-9a-f]{40}$`,
			"m",
		),
	);
	const pushUrlAfterRestore = runGitUnchecked(
		["config", "--worktree", "--get", "remote.origin.pushurl"],
		join(hydrateBridge, "workspace", "hydrated-target"),
	);
	assert.notEqual(
		pushUrlAfterRestore.status,
		0,
		"worktree-local pushurl override should be removed in writable mode",
	);
	const sharedCachePushUrlAfterRestore = runGitUnchecked(
		["config", "--get", "remote.origin.pushurl"],
		hydrateCache,
	);
	assert.notEqual(
		sharedCachePushUrlAfterRestore.status,
		0,
		"writable restore should leave shared cache pushurl unset",
	);

	const releaseCommit = runTool(
		"git",
		["rev-parse", "release/candidate^{commit}"],
		cloudSourceRepo,
	).stdout.trim();
	const hydrateAtRef = run(
		["hydrate-repo.workspace", hydrateRepoId, "--at", "release/candidate"],
		hydrateBridge,
	);
	assertOk(hydrateAtRef, "hydrate-repo.workspace --at failed");
	assert.match(
		hydrateAtRef.stdout,
		new RegExp(
			`^updated repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target commit=[0-9a-f]{40}$`,
			"m",
		),
	);
	const hydratedHeadAtRef = runTool(
		"git",
		["rev-parse", "HEAD"],
		join(hydrateBridge, "workspace", "hydrated-target"),
	).stdout.trim();
	assert.equal(hydratedHeadAtRef, releaseCommit, "--at should retarget hydrated worktree commit");

	write(hydratedMarkerPath, `id: ${otherRepoId}\n`);
	const markerMismatch = run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assert.notEqual(markerMismatch.status, 0, "marker mismatch unexpectedly succeeded");
	assert.match(markerMismatch.stderr, new RegExp(`marker mismatch for repo ${hydrateRepoId}`));
	assert.equal(readFileSync(hydratedMarkerPath, "utf8"), `id: ${otherRepoId}\n`);

	write(hydratedMarkerPath, `  id: ${hydrateRepoId}\n`);
	const markerIndented = run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assert.notEqual(markerIndented.status, 0, "indented marker unexpectedly succeeded");
	assert.match(markerIndented.stderr, /invalid marker format .*no leading indentation is allowed/);

	write(hydratedMarkerPath, `id: ${hydrateRepoId}\nextra: nope\n`);
	const markerExtraKey = run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assert.notEqual(markerExtraKey.status, 0, "extra marker key unexpectedly succeeded");
	assert.match(markerExtraKey.stderr, /invalid marker format .*exactly one top-level key 'id'/);

	const missingRepo = run(["hydrate-repo.workspace", "repo-does-not-exist"], hydrateBridge);
	assert.notEqual(missingRepo.status, 0, "missing repo doc unexpectedly succeeded");
	assert.match(missingRepo.stderr, /repo not found: repo-does-not-exist/);

	const fallbackCreate = run(["hydrate-repo.workspace", fallbackRepoId], hydrateBridge);
	assertOk(fallbackCreate, "hydrate-repo.workspace fallback path failed");
	assert.equal(existsSync(join(hydrateBridge, "workspace", "fallback-target", ".git")), true);
	const fallbackCache = join(hydrateBridge, ".nosedive", "cache", fallbackRepoId);
	assert.equal(
		gitCommonDir(join(hydrateBridge, "workspace", "fallback-target")),
		realpathSync(fallbackCache),
		"local-only hydration should create the workspace worktree from the managed cache",
	);
	assert.notEqual(
		gitCommonDir(join(hydrateBridge, "workspace", "fallback-target")),
		gitCommonDir(sourceRepo),
		"local-only hydration should not create a direct worktree from meta.remotes.local",
	);

	const staleTarget = join(hydrateBridge, "workspace", "stale-target");
	const staleCache = join(hydrateBridge, ".nosedive", "cache", staleWorktreeRepoId);
	mkdirSync(dirname(staleCache), { recursive: true });
	runTool("git", ["clone", "--bare", sourceRepo, staleCache], hydrateBridge);
	runTool("git", ["worktree", "add", "--detach", staleTarget, localMainCommit], staleCache);
	assert.equal(
		existsSync(staleTarget),
		true,
		"stale fixture should create a registered worktree before deleting it",
	);
	rmSync(staleTarget, { recursive: true, force: true });
	const staleHydrate = run(["hydrate-repo.workspace", staleWorktreeRepoId], hydrateBridge);
	assertOk(
		staleHydrate,
		"hydrate-repo.workspace should prune missing registered worktree paths before create",
	);
	assert.match(
		staleHydrate.stdout,
		new RegExp(
			`^created repo=${staleWorktreeRepoId} path=workspace[\\\\/]stale-target commit=[0-9a-f]{40}$`,
			"m",
		),
	);
	assert.equal(
		gitCommonDir(staleTarget),
		realpathSync(staleCache),
		"stale registration recovery should recreate the worktree from the managed cache",
	);
	assert.equal(
		runTool("git", ["status", "--short", "--untracked-files=all"], staleTarget).stdout,
		"",
		"repo ownership marker should not dirty a worktree created after stale registration recovery",
	);

	const unresolvedTarget = join(hydrateBridge, "workspace", "unresolved-target");
	write(
		join(hydrateBridge, "kb", "repo-unresolved.md"),
		`---
kind: repo
id: ${unresolvedRepoId}
name: unresolved
gist: "Unresolved ref fixture"
meta:
  worktree-path: workspace/unresolved-target
  remotes:
    local: repos/source
---
`,
	);
	const unresolvedRef = run(
		["hydrate-repo.workspace", unresolvedRepoId, "--at", "does-not-exist"],
		hydrateBridge,
	);
	assert.notEqual(unresolvedRef.status, 0, "unresolved ref unexpectedly succeeded");
	assert.match(
		unresolvedRef.stderr,
		new RegExp(`failed to resolve ref for repo ${unresolvedRepoId}: ref=does-not-exist`),
	);
	assert.equal(
		existsSync(unresolvedTarget),
		false,
		"target path should not be created when ref resolution fails",
	);

	const emptyFailTarget = join(hydrateBridge, "workspace", "empty-fail-target");
	mkdirSync(emptyFailTarget, { recursive: true });
	write(
		join(hydrateBridge, "kb", "repo-empty-fail.md"),
		`---
kind: repo
id: ${emptyFailRepoId}
name: empty-fail
gist: "Empty target worktree failure fixture"
meta:
  worktree-path: workspace/empty-fail-target
  remotes:
    local: repos/source-empty-fail
---
`,
	);
	const emptyFailCache = join(hydrateBridge, ".nosedive", "cache", emptyFailRepoId);
	mkdirSync(dirname(emptyFailCache), { recursive: true });
	runTool("git", ["clone", "--bare", emptyFailSourceRepo, emptyFailCache], hydrateBridge);
	const cacheGitDir = runTool("git", ["rev-parse", "--git-dir"], emptyFailCache).stdout.trim();
	const cacheWorktreesPath = join(emptyFailCache, cacheGitDir, "worktrees");
	write(cacheWorktreesPath, "block worktree dir creation\n");
	const emptyDirFailure = run(["hydrate-repo.workspace", emptyFailRepoId], hydrateBridge);
	assert.notEqual(
		emptyDirFailure.status,
		0,
		"empty target worktree failure unexpectedly succeeded",
	);
	assert.match(
		emptyDirFailure.stderr,
		new RegExp(`failed to create worktree for repo ${emptyFailRepoId} at .*empty-fail-target`),
	);
	assert.equal(
		readdirSync(emptyFailTarget).length,
		0,
		"empty target directory should remain unchanged when worktree creation fails",
	);

	const unsafePath = run(["hydrate-repo.workspace", unsafeRepoId], hydrateBridge);
	assert.notEqual(unsafePath.status, 0, "unsafe target path unexpectedly succeeded");
	assert.match(unsafePath.stderr, new RegExp(`unsafe target path for repo ${unsafeRepoId}`));

	write(hydratedMarkerPath, `id: ${hydrateRepoId}\n`);
	assertOk(
		run(["hydrate-repo.workspace", hydrateRepoId, "--at", "main"], hydrateBridge),
		"restore hydrated target on main before dehydrate tests failed",
	);

	const dehydrateById = run(["dehydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assertOk(dehydrateById, "dehydrate-repo.workspace by id failed");
	assert.match(
		dehydrateById.stdout,
		new RegExp(`^removed repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target$`, "m"),
	);
	assert.equal(
		existsSync(join(hydrateBridge, "workspace", "hydrated-target")),
		false,
		"dehydrate by id should remove hydrated target",
	);
	assert.equal(
		existsSync(join(hydrateBridge, ".nosedive", "cache", hydrateRepoId)),
		true,
		"dehydrate should preserve managed cache",
	);

	assertOk(
		run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge),
		"rehydrate before dehydrate by name failed",
	);
	const dehydrateByName = run(["dehydrate-repo.workspace", "hydrate"], hydrateBridge);
	assertOk(dehydrateByName, "dehydrate-repo.workspace by name failed");
	assert.match(
		dehydrateByName.stdout,
		new RegExp(`^removed repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target$`, "m"),
	);

	assertOk(
		run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge),
		"rehydrate before dehydrate by path failed",
	);
	const dehydrateByPath = run(
		["dehydrate-repo.workspace", "workspace/hydrated-target"],
		hydrateBridge,
	);
	assertOk(dehydrateByPath, "dehydrate-repo.workspace by directory path failed");
	assert.match(
		dehydrateByPath.stdout,
		new RegExp(`^removed repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target$`, "m"),
	);

	assertOk(
		run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge),
		"rehydrate before dehydrate by marker failed",
	);
	const dehydrateByMarker = run(
		["dehydrate-repo.workspace", "workspace/hydrated-target/.nosedive-ref"],
		hydrateBridge,
	);
	assertOk(dehydrateByMarker, "dehydrate-repo.workspace by marker path failed");
	assert.match(
		dehydrateByMarker.stdout,
		new RegExp(`^removed repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target$`, "m"),
	);

	const dehydrateNoop = run(["dehydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assertOk(dehydrateNoop, "dehydrate-repo.workspace noop failed");
	assert.match(
		dehydrateNoop.stdout,
		new RegExp(`^noop repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target$`, "m"),
	);

	assertOk(
		run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge),
		"rehydrate before dirty protection check failed",
	);
	const dirtyTarget = join(hydrateBridge, "workspace", "hydrated-target");
	write(join(dirtyTarget, ".assertion-dirty"), "dirty\n");
	const dirtyWithoutForce = run(["dehydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assert.notEqual(
		dirtyWithoutForce.status,
		0,
		"dirty dehydrate without --force unexpectedly succeeded",
	);
	assert.match(dirtyWithoutForce.stderr, /(dirty|uncommitted|force)/i);
	assert.equal(
		existsSync(join(dirtyTarget, ".assertion-dirty")),
		true,
		"dirty target should remain after refusal",
	);
	const dirtyWithForce = run(["dehydrate-repo.workspace", hydrateRepoId, "--force"], hydrateBridge);
	assertOk(dirtyWithForce, "dirty dehydrate with --force failed");
	assert.match(
		dirtyWithForce.stdout,
		new RegExp(`^removed repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target$`, "m"),
	);

	assertOk(
		run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge),
		"rehydrate before unpublished-commit protection check failed",
	);
	const aheadTarget = join(hydrateBridge, "workspace", "hydrated-target");
	write(join(aheadTarget, ".assertion-ahead"), "ahead\n");
	runTool("git", ["add", ".assertion-ahead"], aheadTarget);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Assertion",
			"-c",
			"user.email=assertion@example.invalid",
			"commit",
			"-m",
			"assertion unpublished commit",
		],
		aheadTarget,
	);
	const aheadWithoutForce = run(["dehydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assert.notEqual(
		aheadWithoutForce.status,
		0,
		"ahead dehydrate without --force unexpectedly succeeded",
	);
	assert.match(aheadWithoutForce.stderr, /(unpublished|unpushed|ahead|force)/i);
	assert.equal(
		existsSync(join(aheadTarget, ".assertion-ahead")),
		true,
		"ahead target should remain after refusal",
	);
	const aheadWithForce = run(["dehydrate-repo.workspace", hydrateRepoId, "--force"], hydrateBridge);
	assertOk(aheadWithForce, "ahead dehydrate with --force failed");
	assert.match(
		aheadWithForce.stdout,
		new RegExp(`^removed repo=${hydrateRepoId} path=workspace[\\\\/]hydrated-target$`, "m"),
	);

	assertOk(
		run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge),
		"rehydrate before unpublished-commit hydrate refusal check failed",
	);
	const unpublishedTarget = join(hydrateBridge, "workspace", "hydrated-target");
	write(join(unpublishedTarget, ".assertion-unpublished"), "unpublished\n");
	runTool("git", ["add", ".assertion-unpublished"], unpublishedTarget);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Assertion",
			"-c",
			"user.email=assertion@example.invalid",
			"commit",
			"-m",
			"unpublished local commit",
		],
		unpublishedTarget,
	);
	const unpublishedCommit = runTool("git", ["rev-parse", "HEAD"], unpublishedTarget).stdout.trim();
	const hydrateOverUnpublished = run(["hydrate-repo.workspace", hydrateRepoId], hydrateBridge);
	assert.notEqual(
		hydrateOverUnpublished.status,
		0,
		"hydrate over an unpublished commit unexpectedly succeeded",
	);
	assert.match(hydrateOverUnpublished.stderr, /refused/);
	assert.match(hydrateOverUnpublished.stderr, /More info: nosedive render [0-9a-f-]{36}/);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], unpublishedTarget).stdout.trim(),
		unpublishedCommit,
		"refused hydrate should not move the worktree off the unpublished commit",
	);
	assert.equal(existsSync(join(unpublishedTarget, ".assertion-unpublished")), true);

	// --at names the same unpublished commit directly: an explicit target is not an
	// implicit loss, so this must succeed even though the default-trunk hydrate above refused.
	const hydrateAtUnpublished = run(
		["hydrate-repo.workspace", hydrateRepoId, "--at", unpublishedCommit],
		hydrateBridge,
	);
	assertOk(hydrateAtUnpublished, "hydrate --at the unpublished commit itself should succeed");

	const outsideDehydrateDir = join(tmp, "outside-dehydrate-target");
	mkdirSync(outsideDehydrateDir, { recursive: true });
	write(join(outsideDehydrateDir, "keep.txt"), "outside\n");
	const insideUnowned = join(hydrateBridge, "workspace", "not-owned");
	mkdirSync(insideUnowned, { recursive: true });
	write(join(insideUnowned, "keep.txt"), "inside\n");

	const unsafeOutside = run(
		["dehydrate-repo.workspace", "../outside-dehydrate-target"],
		hydrateBridge,
	);
	assert.notEqual(unsafeOutside.status, 0, "outside-workspace dehydrate unexpectedly succeeded");
	assert.match(unsafeOutside.stderr, /(workspace|outside|relative)/i);

	const unsafeInside = run(["dehydrate-repo.workspace", "workspace/not-owned"], hydrateBridge);
	assert.notEqual(unsafeInside.status, 0, "unowned in-workspace dehydrate unexpectedly succeeded");
	assert.match(unsafeInside.stderr, /(marker|\.nosedive-ref|owned)/i);

	const unsafeOutsideForce = run(
		["dehydrate-repo.workspace", "../outside-dehydrate-target", "--force"],
		hydrateBridge,
	);
	assert.notEqual(
		unsafeOutsideForce.status,
		0,
		"outside-workspace dehydrate with --force unexpectedly succeeded",
	);

	const unsafeInsideForce = run(
		["dehydrate-repo.workspace", "workspace/not-owned", "--force"],
		hydrateBridge,
	);
	assert.notEqual(
		unsafeInsideForce.status,
		0,
		"unowned in-workspace dehydrate with --force unexpectedly succeeded",
	);

	assert.equal(
		readFileSync(join(outsideDehydrateDir, "keep.txt"), "utf8"),
		"outside\n",
		"outside-workspace file should remain untouched",
	);
	assert.equal(
		readFileSync(join(insideUnowned, "keep.txt"), "utf8"),
		"inside\n",
		"in-workspace unowned file should remain untouched",
	);
});
