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
const tmp = createTmp("nuke");
const noBridge = createNoBridge(tmp);

test("nuke", () => {
	const nukeWorkspaceBridge = join(tmp, "nuke-workspace-bridge");
	const nukeWorkspaceRepoIdA = "019fbf3b-5f7f-7a39-bd1b-5ffdf62fa101";
	const nukeWorkspaceRepoIdB = "019fbf3b-5f7f-7a39-bd1b-5ffdf62fa102";
	const nukeWorkspaceDiveId = "019fbf3b-5f7f-7a39-bd1b-5ffdf62fa103";
	mkdirSync(join(nukeWorkspaceBridge, "kb"), { recursive: true });
	mkdirSync(join(nukeWorkspaceBridge, "workspace"), { recursive: true });
	mkdirSync(join(nukeWorkspaceBridge, "repos", "source"), { recursive: true });
	runTool("git", ["init", "-b", "main"], nukeWorkspaceBridge);
	runTool("git", ["config", "user.email", "nuke-workspace@example.invalid"], nukeWorkspaceBridge);
	runTool("git", ["config", "user.name", "Nuke Workspace"], nukeWorkspaceBridge);
	const nukeWorkspaceSource = join(nukeWorkspaceBridge, "repos", "source");
	runTool("git", ["init", "-b", "main"], nukeWorkspaceSource);
	runTool("git", ["config", "user.email", "nuke-workspace@example.invalid"], nukeWorkspaceSource);
	runTool("git", ["config", "user.name", "Nuke Workspace"], nukeWorkspaceSource);
	write(join(nukeWorkspaceSource, "README.md"), "workspace nuke source\n");
	runTool("git", ["add", "README.md"], nukeWorkspaceSource);
	runTool("git", ["commit", "-m", "workspace nuke source"], nukeWorkspaceSource);
	writeBridgeConfig(nukeWorkspaceBridge);
	write(
		join(nukeWorkspaceBridge, "kb", "repo-a.md"),
		`---
kind: repo
id: ${nukeWorkspaceRepoIdA}
name: workspace-nuke-a
gist: "Workspace nuke repo A"
meta:
  path: workspace/repo-a
  remotes:
    local: repos/source
---
`,
	);
	write(
		join(nukeWorkspaceBridge, "kb", "repo-b.md"),
		`---
kind: repo
id: ${nukeWorkspaceRepoIdB}
name: workspace-nuke-b
gist: "Workspace nuke repo B"
meta:
  path: workspace/repo-b
  remotes:
    local: repos/source
---
`,
	);
	assertOk(
		run(["hydrate-repo.workspace", nukeWorkspaceRepoIdA], nukeWorkspaceBridge),
		"hydrate repo A before nuke --workspace failed",
	);
	assertOk(
		run(["hydrate-repo.workspace", nukeWorkspaceRepoIdB], nukeWorkspaceBridge),
		"hydrate repo B before nuke --workspace failed",
	);
	const nukeWorkspaceTargetA = join(nukeWorkspaceBridge, "workspace", "repo-a");
	const nukeWorkspaceTargetB = join(nukeWorkspaceBridge, "workspace", "repo-b");
	write(join(nukeWorkspaceTargetA, "dirty.txt"), "force removes me\n");
	write(join(nukeWorkspaceBridge, "workspace", ".gitkeep"), "preserve me\n");
	write(join(nukeWorkspaceBridge, "workspace", "scratch.txt"), "preserve me too\n");
	write(
		join(nukeWorkspaceBridge, "workspace", "wrong-path", ".nosedive-ref"),
		`id: ${nukeWorkspaceRepoIdA}\n`,
	);
	write(
		join(nukeWorkspaceBridge, "workspace", "unknown-repo", ".nosedive-ref"),
		"id: 019fbf3b-5f7f-7a39-bd1b-5ffdf62fa999\n",
	);
	write(join(nukeWorkspaceBridge, "workspace", ".nosedive-ref"), `id: ${nukeWorkspaceDiveId}\n`);
	const nukeWorkspace = run(["nuke", "--workspace"], nukeWorkspaceBridge);
	assertOk(nukeWorkspace, "nuke --workspace failed");
	assert.match(nukeWorkspace.stdout, /Nuked workspace; removed 2 repos and 1 marker file/);
	assert.deepEqual(
		readdirSync(join(nukeWorkspaceBridge, "workspace")).sort(),
		[".gitkeep", "scratch.txt", "unknown-repo", "wrong-path"],
		"nuke --workspace should preserve unmanaged workspace entries",
	);
	assert.equal(existsSync(nukeWorkspaceTargetA), false);
	assert.equal(existsSync(nukeWorkspaceTargetB), false);
	assert.equal(
		readFileSync(join(nukeWorkspaceBridge, "workspace", ".gitkeep"), "utf8"),
		"preserve me\n",
	);
	assert.equal(
		readFileSync(join(nukeWorkspaceBridge, "workspace", "scratch.txt"), "utf8"),
		"preserve me too\n",
	);
	assert.equal(
		readFileSync(join(nukeWorkspaceBridge, "workspace", "wrong-path", ".nosedive-ref"), "utf8"),
		`id: ${nukeWorkspaceRepoIdA}\n`,
	);
	assert.equal(
		readFileSync(join(nukeWorkspaceBridge, "workspace", "unknown-repo", ".nosedive-ref"), "utf8"),
		"id: 019fbf3b-5f7f-7a39-bd1b-5ffdf62fa999\n",
	);
	const nukeWorkspaceCacheA = join(nukeWorkspaceBridge, ".nosedive", "cache", nukeWorkspaceRepoIdA);
	const nukeWorkspaceCacheB = join(nukeWorkspaceBridge, ".nosedive", "cache", nukeWorkspaceRepoIdB);
	assert.doesNotMatch(
		runTool("git", ["worktree", "list", "--porcelain"], nukeWorkspaceCacheA).stdout,
		new RegExp(escapeRegExp(nukeWorkspaceTargetA)),
		"nuke --workspace should unregister repo A's worktree path",
	);
	assert.doesNotMatch(
		runTool("git", ["worktree", "list", "--porcelain"], nukeWorkspaceCacheB).stdout,
		new RegExp(escapeRegExp(nukeWorkspaceTargetB)),
		"nuke --workspace should unregister repo B's worktree path",
	);

	const nukeConfigBridge = join(tmp, "nuke-config-bridge");
	mkdirSync(nukeConfigBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], nukeConfigBridge);
	const nukeConfigSeed = run(["seed", "--headless", "--file", "AGENTS.md"], nukeConfigBridge, "");
	assertOk(nukeConfigSeed, "seed before nuke --config failed");
	const nukeConfigExclude = join(nukeConfigBridge, ".git", "info", "exclude");
	write(
		nukeConfigExclude,
		`${readFileSync(nukeConfigExclude, "utf8").replace(/\n*$/, "\n")}# BEGIN nosedive-managed package-foundation exclude\n# owner: legacy fixture\nkb/old-foundation.md\n# END nosedive-managed package-foundation exclude\n`,
	);
	const nukeConfig = run(["nuke", "--config"], nukeConfigBridge, "");
	assertOk(nukeConfig, "nuke --config failed");
	assert.match(nukeConfig.stdout, /Nuked bridge config; removed 2 files/);
	assert.equal(existsSync(join(nukeConfigBridge, ".nosedive", "config.yaml")), false);
	assert.equal(existsSync(join(nukeConfigBridge, ".nosedive", ".gitignore")), false);
	assert.equal(existsSync(join(nukeConfigBridge, ".nosedive.local.yaml")), false);
	assert.doesNotMatch(readFileSync(nukeConfigExclude, "utf8"), /nosedive-managed config exclude/);
	assert.doesNotMatch(readFileSync(nukeConfigExclude, "utf8"), /package-foundation exclude/);

	const nonGitSeed = join(tmp, "non-git-seed");
	mkdirSync(nonGitSeed, { recursive: true });
	const seedOutsideGit = run(["seed"], nonGitSeed, "");
	assert.notEqual(seedOutsideGit.status, 0, "seed outside git unexpectedly succeeded");
	assert.match(seedOutsideGit.stderr, /nosedive seed must be run inside a git repository/);
});
