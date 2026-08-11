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
const tmp = createTmp("seed-migration");
const noBridge = createNoBridge(tmp);

test("seed-migration", () => {
	// compatibility level 0 and copied into KB docs during seed.
	const backlogBridge = join(tmp, "backlog-bridge");
	const bridgeRepoId = "00000000-0000-7000-8000-000000000111";
	const effortRepoId = "00000000-0000-7000-8000-000000000222";
	const childEffortId = "00000000-0000-7000-8000-000000000333";
	const relatedEffortId = "00000000-0000-7000-8000-000000000444";
	mkdirSync(backlogBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], backlogBridge);
	runTool("git", ["config", "user.name", "Backlog Person"], backlogBridge);
	runTool("git", ["config", "user.email", "backlog@example.invalid"], backlogBridge);
	runTool(
		"git",
		["remote", "add", "origin", "https://example.com/dan/backlog-bridge.git"],
		backlogBridge,
	);
	write(
		join(backlogBridge, "kb", `${bridgeRepoId}.md`),
		`---
kind: repo
id: ${bridgeRepoId}
name: bridge-existing
gist: Existing bridge repo doc.
meta:
  path: workspace/__self
  remotes:
    cloud: https://example.com/dan/backlog-bridge.git
---

# Bridge Existing
`,
	);
	write(
		join(backlogBridge, "kb", `${effortRepoId}.md`),
		`---
kind: repo
id: ${effortRepoId}
name: alpha
gist: Alpha repo.
meta:
  path: workspace/alpha
---

# Alpha
`,
	);
	write(
		join(backlogBridge, "backlog", "project", "Project.md"),
		`---
gist: Main gist
repos:
  - alpha:ro
links:
  - ${relatedEffortId}:
      rel: related
priority: high
---

# Project Title

Main body.
`,
	);
	write(
		join(backlogBridge, "backlog", "gogglebox", "episode-one", "EpisodeOne.md"),
		`---
gist: Gogglebox gist
---

# Gogglebox Episode

Episode body.
`,
	);
	write(
		join(backlogBridge, "backlog", "project", "main-effort", "MainEffort.md"),
		`---
id: ${childEffortId}
name: Stale Name
gist: Child gist
repos:
  - alpha@main:rw
owner: dana
---

# Main Effort Title

Child body.
`,
	);
	runTool("git", ["add", "kb", "backlog"], backlogBridge);
	runTool("git", ["commit", "-m", "legacy backlog"], backlogBridge);

	const backlogSeed = run(["seed", "--headless", "--file", "AGENTS.md"], backlogBridge, "");
	assertOk(backlogSeed, "seed with tracked backlog failed");
	assert.match(backlogSeed.stdout, /Running migration .*019f916b-f800-723d-b096-07d4300ff28a\.md/);
	assert.match(backlogSeed.stdout, /Source: backlog/);
	assert.match(backlogSeed.stdout, /Efforts copied: 3/);
	assert.match(backlogSeed.stdout, new RegExp(`Bridge repo: reused ${bridgeRepoId}`));
	assert.match(backlogSeed.stdout, /Copied files:/);
	assert.match(backlogSeed.stdout, /gogglebox\/episode-one\/EpisodeOne\.md/);
	assert.match(backlogSeed.stdout, /project\/Project\.md/);
	assert.match(backlogSeed.stdout, /project\/main-effort\/MainEffort\.md/);
	assert.match(backlogSeed.stdout, /Legacy backlog\/ remains after copying/);
	const backlogMemoMatch = /Backlog memo: ([0-9a-f-]{36})/.exec(backlogSeed.stdout);
	assert.ok(backlogMemoMatch, "seed did not print backlog memo id");
	const backlogMemoId = backlogMemoMatch[1];
	assert.equal(existsSync(join(backlogBridge, "backlog", "project", "Project.md")), true);
	assert.match(
		readFileSync(join(backlogBridge, ".nosedive", "config.yaml"), "utf8"),
		new RegExp(`^backlog: ${backlogMemoId}$`, "m"),
	);

	const kbTexts = readdirSync(join(backlogBridge, "kb"))
		.filter((name) => name.endsWith(".md"))
		.map((name) => [name, readFileSync(join(backlogBridge, "kb", name), "utf8")]);
	const topEffort = kbTexts.find(
		([, text]) => /^kind: feat$/m.test(text) && /^name: project$/m.test(text),
	);
	assert.ok(topEffort, "top-level effort doc was not created");
	const topEffortId = /^id: ([0-9a-f-]{36})$/m.exec(topEffort[1])?.[1];
	assert.ok(topEffortId, "top-level effort id was not minted");
	assert.notEqual(topEffortId, childEffortId);
	assert.equal(topEffort[0], `${topEffortId}.md`);
	assert.match(topEffort[1], /^gist: Main gist$/m);
	assert.match(topEffort[1], new RegExp(`\\nscopes:\\n  - ${effortRepoId}\\n`));
	assert.match(topEffort[1], new RegExp(`kb/${relatedEffortId}\\.md:\\n      rel: related`));
	assert.match(topEffort[1], new RegExp(`kb/${childEffortId}\\.md:\\n      rel: child`));
	assert.match(topEffort[1], /meta:\n  priority: high/);

	const goggleboxEffort = kbTexts.find(
		([, text]) => /^kind: feat$/m.test(text) && /^name: episode-one\.gogglebox$/m.test(text),
	);
	assert.ok(goggleboxEffort, "namespaced gogglebox effort doc was not created");
	const goggleboxEffortId = /^id: ([0-9a-f-]{36})$/m.exec(goggleboxEffort[1])?.[1];
	assert.ok(goggleboxEffortId, "namespaced gogglebox effort id was not minted");
	assert.match(goggleboxEffort[1], /^gist: Gogglebox gist$/m);

	const childDoc = readFileSync(join(backlogBridge, "kb", `${childEffortId}.md`), "utf8");
	assert.match(childDoc, /^kind: feat$/m);
	assert.match(childDoc, new RegExp(`^id: ${childEffortId}$`, "m"));
	assert.match(childDoc, /^name: main-effort\.project$/m);
	assert.match(childDoc, /^gist: Child gist$/m);
	assert.match(childDoc, new RegExp(`\\nscopes:\\n  - ${effortRepoId}\\n`));
	assert.match(childDoc, new RegExp(`kb/${topEffortId}\\.md:\\n      rel: parent`));
	assert.match(childDoc, /meta:\n  name: Stale Name\n  owner: dana/);

	const backlogMemo = readFileSync(join(backlogBridge, "kb", `${backlogMemoId}.md`), "utf8");
	assert.match(backlogMemo, /^kind: memo$/m);
	assert.match(backlogMemo, /^name: backlog\.backlog-bridge$/m);
	assert.doesNotMatch(backlogMemo, /^scopes:/m);
	assert.match(backlogMemo, new RegExp(`kb/${goggleboxEffortId}\\.md:\\n      rel: main-effort`));
	assert.match(backlogMemo, new RegExp(`kb/${topEffortId}\\.md:\\n      rel: main-effort`));
	assert.match(backlogMemo, /### Gogglebox/);
	assert.match(
		backlogMemo,
		new RegExp(`- \\[Gogglebox Episode\\]\\(${goggleboxEffortId}\\.md\\): Gogglebox gist`),
	);
	assert.match(
		backlogMemo,
		new RegExp(`- \\[Project Title\\]\\(${topEffortId}\\.md\\): Main gist`),
	);
	assert.match(
		backlogMemo,
		new RegExp(`  - \\[Main Effort Title\\]\\(${childEffortId}\\.md\\): Child gist`),
	);
	const dumpedBacklogMemo = run(["dump-backlog"], backlogBridge);
	assertOk(dumpedBacklogMemo, "dump-backlog L1 memo render failed");
	assert.equal(
		dumpedBacklogMemo.stdout,
		[
			"",
			"# Backlog",
			"",
			"## Current efforts",
			"",
			"### Gogglebox",
			"",
			`- [Gogglebox Episode](${goggleboxEffortId}.md): Gogglebox gist`,
			"",
			`- [Project Title](${topEffortId}.md): Main gist`,
			`  - [Main Effort Title](${childEffortId}.md): Child gist`,
			"",
		].join("\n"),
	);
	const betaEffortId = "00000000-0000-7000-8000-000000000555";
	write(
		join(backlogBridge, "kb", `${betaEffortId}.md`),
		`---
kind: feat
id: ${betaEffortId}
name: beta
gist: Beta gist
---

# Beta

Beta body.
`,
	);
	write(
		join(backlogBridge, "kb", `${backlogMemoId}.md`),
		`---
kind: memo
id: ${backlogMemoId}
name: backlog.backlog-bridge
gist: Current backlog for backlog-bridge.
---

# Stale
`,
	);
	const updateBacklog = run(["update-backlog"], backlogBridge);
	assertOk(updateBacklog, "update-backlog failed");
	assert.match(updateBacklog.stdout, new RegExp(`Updated backlog memo: kb/${backlogMemoId}\\.md`));
	const updatedBacklogMemo = readFileSync(join(backlogBridge, "kb", `${backlogMemoId}.md`), "utf8");
	assert.match(updatedBacklogMemo, new RegExp(`kb/${betaEffortId}\\.md:\\n      rel: main-effort`));
	assert.match(updatedBacklogMemo, new RegExp(`- \\[Beta\\]\\(${betaEffortId}\\.md\\): Beta gist`));
	assert.match(updatedBacklogMemo, /### Gogglebox/);
	assert.doesNotMatch(updatedBacklogMemo, /# Stale/);
	const updatedDumpedBacklog = run(["dump-backlog"], backlogBridge);
	assertOk(updatedDumpedBacklog, "dump-backlog after update-backlog failed");
	assert.match(
		updatedDumpedBacklog.stdout,
		new RegExp(`- \\[Beta\\]\\(${betaEffortId}\\.md\\): Beta gist`),
	);

	// If backlog/ is absent, seed falls back to efforts/ and can mint the
	// bridge repo doc from the current worktree.
	const effortsBridge = join(tmp, "efforts-bridge");
	mkdirSync(effortsBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], effortsBridge);
	runTool("git", ["config", "user.name", "Efforts Person"], effortsBridge);
	runTool("git", ["config", "user.email", "efforts@example.invalid"], effortsBridge);
	write(
		join(effortsBridge, "efforts", "solo", "Solo.md"),
		`---
gist: Solo gist
---

# Solo
`,
	);
	const effortsSeed = run(["seed", "--headless", "--file", "AGENTS.md"], effortsBridge, "");
	assertOk(effortsSeed, "seed with efforts fallback failed");
	assert.match(effortsSeed.stdout, /Source: efforts/);
	assert.match(effortsSeed.stdout, /Bridge repo: created [0-9a-f-]{36}/);
	assert.match(effortsSeed.stdout, /Efforts copied: 1/);
	assert.match(effortsSeed.stdout, /solo\/Solo\.md/);

	// Dirty managed migration targets abort before any migration writes.
	const dirtyManagedBridge = join(tmp, "dirty-managed-bridge");
	mkdirSync(dirtyManagedBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], dirtyManagedBridge);
	write(join(dirtyManagedBridge, "efforts", "solo", "Solo.md"), "# Solo\n");
	write(join(dirtyManagedBridge, "kb", "dirty.md"), "# Dirty\n");
	const dirtyManagedSeed = run(["seed", "--headless"], dirtyManagedBridge, "");
	assert.notEqual(
		dirtyManagedSeed.status,
		0,
		"seed with dirty managed target unexpectedly succeeded",
	);
	assert.match(dirtyManagedSeed.stderr, /managed migration paths are dirty/);
	assert.match(dirtyManagedSeed.stderr, /kb: \?\? kb\/dirty\.md/);
	assert.equal(existsSync(join(dirtyManagedBridge, ".nosedive", "config.yaml")), false);

	// Both a legacy file and a split base config present at once is
	// unrecognized/ambiguous: seed aborts loudly and writes nothing.
	const ambiguousBridge = join(tmp, "ambiguous-bridge");
	mkdirSync(ambiguousBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], ambiguousBridge);
	write(join(ambiguousBridge, ".nosediverc"), "workspace: ./workspace\n");
	write(join(ambiguousBridge, ".nosedive", "config.yaml"), "compatibility-level: 2\n");
	const initAmbiguous = run(["seed", "--headless"], ambiguousBridge, "");
	assert.notEqual(initAmbiguous.status, 0, "init with ambiguous config unexpectedly succeeded");
	assert.match(initAmbiguous.stderr, /bridge config is ambiguous/);
	assert.match(initAmbiguous.stderr, /Remove .*\.nosediverc manually before running seed again/);
	assert.equal(
		readFileSync(join(ambiguousBridge, ".nosediverc"), "utf8"),
		"workspace: ./workspace\n",
	);
	assert.equal(
		readFileSync(join(ambiguousBridge, ".nosedive", "config.yaml"), "utf8"),
		"compatibility-level: 2\n",
	);

	// A split base config with no readable compatibility-level is likewise
	// unrecognized: seed refuses to guess rather than silently overwriting.
	const unversionedBridge = join(tmp, "unversioned-bridge");
	mkdirSync(unversionedBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], unversionedBridge);
	write(join(unversionedBridge, ".nosedive", "config.yaml"), "workspace: ./workspace\n");
	const initUnversioned = run(["seed", "--headless"], unversionedBridge, "");
	assert.notEqual(initUnversioned.status, 0, "init with unversioned config unexpectedly succeeded");
	assert.match(initUnversioned.stderr, /no readable compatibility-level/);
	assert.equal(
		readFileSync(join(unversionedBridge, ".nosedive", "config.yaml"), "utf8"),
		"workspace: ./workspace\n",
	);

	// A migration script failure surfaces the migration's summary plus the
	// full content (gist + body) of its kb doc inline, so an agent hitting
	// this can act on it directly without the doc needing to live anywhere
	// in the bridge's kb, and leaves the bridge unmigrated rather than
	// partially written.
	const scriptFailureBridge = join(tmp, "script-failure-bridge");
	mkdirSync(scriptFailureBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], scriptFailureBridge);
	write(join(scriptFailureBridge, ".nosediverc"), "workspace: ./workspace\nkb: ./kb\n");
	const migrationScriptPath = join(root, "kb", "artifacts", packageMigrationScript);
	const originalMigrationScript = readFileSync(migrationScriptPath, "utf8");
	try {
		writeFileSync(
			migrationScriptPath,
			'export function migrate() { throw new Error("simulated migration failure"); }\n',
			"utf8",
		);
		const initScriptFailure = run(["seed", "--headless"], scriptFailureBridge, "");
		assert.notEqual(
			initScriptFailure.status,
			0,
			"init with a failing migration script unexpectedly succeeded",
		);
		assert.match(
			initScriptFailure.stderr,
			/migration '.*' \(L0->L1\) failed: simulated migration failure/,
		);
		assert.match(initScriptFailure.stderr, /Migrates a compatibility level 0 bridge into L1/);
		assert.match(initScriptFailure.stderr, /# Seed L1 Bridge/);
		assert.match(initScriptFailure.stderr, /## Clean Gate/);
		assert.equal(existsSync(join(scriptFailureBridge, "kb", packageMigrationDoc)), false);
		assert.equal(existsSync(join(scriptFailureBridge, ".nosediverc")), true);
		assert.equal(existsSync(join(scriptFailureBridge, ".nosedive", "config.yaml")), false);
	} finally {
		writeFileSync(migrationScriptPath, originalMigrationScript, "utf8");
	}
});

/**
 * L1 -> L2 declares no migration: the level is a release note, not a data
 * change. What has to be proven is that seed crosses it writing nothing but the
 * config line -- and the proof is git status on a fixture bridge, not the log.
 */
test("seed bumps an L1 bridge to L2 with no kb writes at all", () => {
	const bridge = join(tmp, "l2-bump-bridge");
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Bump Person"], bridge);
	runTool("git", ["config", "user.email", "bump@example.invalid"], bridge);

	const featId = "00000000-0000-7000-8000-0000000009a1";
	const backlogId = "00000000-0000-7000-8000-0000000009a3";
	write(
		join(bridge, ".nosedive", "config.yaml"),
		[
			"compatibility-level: 1",
			"workspace: ./workspace",
			"kb: ./kb",
			`backlog: ${backlogId}`,
			"",
		].join("\n"),
	);
	// Still says `kind: effort`, which is exactly what the retired migration
	// used to rewrite. Nothing may touch it now.
	write(
		join(bridge, "kb", `${featId}.md`),
		[
			"---",
			"kind: effort",
			`id: ${featId}`,
			"name: left-alone",
			'gist: "Left alone."',
			"---",
			"",
			"# Left Alone",
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${backlogId}.md`),
		[
			"---",
			"kind: memo",
			`id: ${backlogId}`,
			"name: backlog.l2-bump",
			'gist: "Backlog."',
			"---",
			"",
			"# Backlog",
			"",
		].join("\n"),
	);
	write(
		join(bridge, "AGENTS.md"),
		[
			"# Agents",
			"",
			"<!-- BEGIN nosedive managed instructions -->",
			"<!-- END nosedive managed instructions -->",
			"",
		].join("\n"),
	);
	runTool("git", ["add", "."], bridge);
	runTool("git", ["commit", "-m", "l1 bridge"], bridge);

	const seeded = run(["seed", "--headless"], bridge);
	assert.equal(seeded.status, 0, seeded.stderr);
	assert.doesNotMatch(seeded.stdout, /Running migration/);

	assert.match(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
		/^compatibility-level: 2$/m,
	);
	const dirty = runGit(["status", "--porcelain", "--", "kb"], bridge).stdout.trim();
	assert.equal(dirty, "", `seed wrote to the kb crossing a migration-free level:\n${dirty}`);
	assert.match(readFileSync(join(bridge, "kb", `${featId}.md`), "utf8"), /^kind: effort$/m);
});

/**
 * A bridge one level behind with no migration in the gap is not a data problem,
 * so every contracted command runs, and nothing warns about it. Only preflight
 * mentions drift, and only in its report.
 */
test("a migration-free level gap refuses nothing and warns nowhere", () => {
	const bridge = join(tmp, "l1-quiet-bridge");
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	const backlogId = "00000000-0000-7000-8000-0000000009b1";
	write(
		join(bridge, ".nosedive", "config.yaml"),
		[
			"compatibility-level: 1",
			"workspace: ./workspace",
			"kb: ./kb",
			`backlog: ${backlogId}`,
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${backlogId}.md`),
		[
			"---",
			"kind: memo",
			`id: ${backlogId}`,
			"name: backlog.l1-quiet",
			'gist: "Backlog."',
			"---",
			"",
			"# Quiet Backlog",
			"",
		].join("\n"),
	);

	const dumped = run(["dump-backlog"], bridge);
	assertOk(dumped, "dump-backlog refused a bridge with no migration in the gap");
	assert.match(dumped.stdout, /^# Quiet Backlog$/m);
	assert.equal(dumped.stderr, "", `a migration-free gap must be silent, got: ${dumped.stderr}`);
});

/**
 * `seed` writes the level line on every run, and the config is checked in and
 * shared. A package older than the bridge must not write its own lower level
 * over the higher one already there.
 */
test("seed refuses to write a level lower than the bridge already carries", () => {
	const bridge = join(tmp, "downgrade-bridge");
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	const configPath = join(bridge, ".nosedive", "config.yaml");
	const config = ["compatibility-level: 99", "workspace: ./workspace", "kb: ./kb", ""].join("\n");
	write(configPath, config);
	write(
		join(bridge, "AGENTS.md"),
		[
			"# Agents",
			"",
			"<!-- BEGIN nosedive managed instructions -->",
			"<!-- END nosedive managed instructions -->",
			"",
		].join("\n"),
	);

	const seeded = run(["seed", "--headless"], bridge);
	assert.notEqual(seeded.status, 0, "seed unexpectedly wrote a level downgrade");
	assert.match(seeded.stderr, /is at compatibility level 99/);
	assert.match(seeded.stderr, /this nosedive is at level 2/);
	assert.match(seeded.stderr, /render 019fee38-0674-7e46-be0c-a3405ece099e/);
	assert.equal(readFileSync(configPath, "utf8"), config, "config bytes changed");
});
