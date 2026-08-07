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
const tmp = createTmp("add-repo-effort");
const noBridge = createNoBridge(tmp);

test("add-repo-effort", () => {
	const addRepoEffortBridge = join(tmp, "add-repo-effort-bridge");
	const effortId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e001";
	const effortDiveId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e010";
	const alphaScopeRepoId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e002";
	const betaScopeRepoId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e003";
	const gammaScopeRepoId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e004";
	const duplicateScopeRepoIdA = "019fbf74-9c6e-71a2-a3f2-f0c99be3e005";
	const duplicateScopeRepoIdB = "019fbf74-9c6e-71a2-a3f2-f0c99be3e006";
	mkdirSync(join(addRepoEffortBridge, ".nosedive"), { recursive: true });
	mkdirSync(join(addRepoEffortBridge, "kb"), { recursive: true });
	mkdirSync(join(addRepoEffortBridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], addRepoEffortBridge);
	runTool("git", ["config", "user.email", "dev@example.invalid"], addRepoEffortBridge);
	runTool("git", ["config", "user.name", "Nosedive Dev"], addRepoEffortBridge);
	write(
		join(addRepoEffortBridge, ".nosedive", "config.yaml"),
		`compatibility-level: 2
workspace: ./workspace
kb: ./kb
backlog: 019fbf74-9c6e-71a2-a3f2-f0c99be3e000
`,
	);
	write(
		join(addRepoEffortBridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: feature
gist: "Feature effort for add-repo.effort tests."
custom: keep-me
scopes:
  - ${alphaScopeRepoId}:
      mode: rw
---

# Feature

Do not rewrite this body.
`,
	);
	write(
		join(addRepoEffortBridge, "kb", `${effortDiveId}.md`),
		`---
kind: dive
id: ${effortDiveId}
name: feature.abcdef
gist: "Active dive for add-repo.effort tests."
effort: kb/${effortId}.md
---

# Feature dive
`,
	);
	write(join(addRepoEffortBridge, "workspace", ".nosedive-ref"), `id: ${effortDiveId}\n`);
	for (const [id, name] of [
		[alphaScopeRepoId, "alpha"],
		[betaScopeRepoId, "beta"],
		[gammaScopeRepoId, "gamma"],
		[duplicateScopeRepoIdA, "duplicate"],
		[duplicateScopeRepoIdB, "duplicate"],
	]) {
		write(
			join(addRepoEffortBridge, "kb", `${id}.md`),
			`---
kind: repo
id: ${id}
name: ${name}
gist: "${name} repo."
meta:
  path: workspace/${name}
---
`,
		);
	}

	const addEffortByName = run(["add-repo.effort", "beta"], addRepoEffortBridge);
	assertOk(addEffortByName, "add-repo.effort by name failed");
	assert.match(
		addEffortByName.stdout,
		new RegExp(`Added scope ${betaScopeRepoId}:rw to .*${effortId}\\.md`),
	);
	const effortAfterName = readFileSync(join(addRepoEffortBridge, "kb", `${effortId}.md`), "utf8");
	assert.match(effortAfterName, /custom: keep-me/);
	assert.match(effortAfterName, new RegExp(`${betaScopeRepoId}:\\n\\s+mode: rw`));
	assert.doesNotMatch(effortAfterName, new RegExp(`${betaScopeRepoId}:\\n\\s+ref:`));
	assert.match(effortAfterName, /Do not rewrite this body\./);

	const addEffortWithModifiers = run(
		["add-repo.effort", gammaScopeRepoId, "--ref", "release/candidate", "--read-only"],
		addRepoEffortBridge,
	);
	assertOk(addEffortWithModifiers, "add-repo.effort with modifiers failed");
	const effortAfterModifiers = readFileSync(
		join(addRepoEffortBridge, "kb", `${effortId}.md`),
		"utf8",
	);
	assert.match(
		effortAfterModifiers,
		new RegExp(`${gammaScopeRepoId}:\\n\\s+ref: release/candidate\\n\\s+mode: ro`),
	);

	const duplicateEffortAdd = run(["add-repo.effort", "beta"], addRepoEffortBridge);
	assert.notEqual(duplicateEffortAdd.status, 0, "duplicate add-repo.effort unexpectedly succeeded");
	assert.match(
		duplicateEffortAdd.stderr,
		new RegExp(`effort already includes scope ${betaScopeRepoId}`),
	);

	const ambiguousEffortAdd = run(["add-repo.effort", "duplicate"], addRepoEffortBridge);
	assert.notEqual(ambiguousEffortAdd.status, 0, "ambiguous add-repo.effort unexpectedly succeeded");
	assert.match(ambiguousEffortAdd.stderr, /repo name is ambiguous: duplicate/);
	assert.match(ambiguousEffortAdd.stderr, new RegExp(duplicateScopeRepoIdA));
	assert.match(ambiguousEffortAdd.stderr, new RegExp(duplicateScopeRepoIdB));

	rmSync(join(addRepoEffortBridge, "workspace", ".nosedive-ref"), { force: true });
	const addWithoutActiveEffort = run(["add-repo.effort", "alpha"], addRepoEffortBridge);
	assert.notEqual(
		addWithoutActiveEffort.status,
		0,
		"add-repo.effort without active effort unexpectedly succeeded",
	);
	assert.match(addWithoutActiveEffort.stderr, /no active dive/);
	assert.match(addWithoutActiveEffort.stderr, /workspace\/\.nosedive-ref/);
});
