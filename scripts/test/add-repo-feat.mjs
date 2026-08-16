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
const tmp = createTmp("add-repo-feat");
const noBridge = createNoBridge(tmp);

test("add-repo-feat", () => {
	const addRepoFeatBridge = join(tmp, "add-repo-feat-bridge");
	const effortId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e001";
	const effortDiveId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e010";
	const alphaScopeRepoId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e002";
	const betaScopeRepoId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e003";
	const gammaScopeRepoId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e004";
	const duplicateScopeRepoIdA = "019fbf74-9c6e-71a2-a3f2-f0c99be3e005";
	const duplicateScopeRepoIdB = "019fbf74-9c6e-71a2-a3f2-f0c99be3e006";
	mkdirSync(join(addRepoFeatBridge, ".nosedive"), { recursive: true });
	mkdirSync(join(addRepoFeatBridge, "kb"), { recursive: true });
	mkdirSync(join(addRepoFeatBridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], addRepoFeatBridge);
	runTool("git", ["config", "user.email", "dev@example.invalid"], addRepoFeatBridge);
	runTool("git", ["config", "user.name", "Nosedive Dev"], addRepoFeatBridge);
	write(
		join(addRepoFeatBridge, ".nosedive", "config.yaml"),
		`compatibility-level: 2
workspace: ./workspace
kb: ./kb
backlog: 019fbf74-9c6e-71a2-a3f2-f0c99be3e000
`,
	);
	write(
		join(addRepoFeatBridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: feature
gist: "Feature effort for add-repo.feat tests."
custom: keep-me
scopes:
  - ${alphaScopeRepoId}:
      work-branch: work/feature
---

# Feature

Do not rewrite this body.
`,
	);
	write(
		join(addRepoFeatBridge, "kb", `${effortDiveId}.md`),
		`---
kind: dive
id: ${effortDiveId}
name: feature.abcdef
gist: "Active dive for add-repo.feat tests."
effort: kb/${effortId}.md
---

# Feature dive
`,
	);
	write(join(addRepoFeatBridge, "workspace", ".nosedive-ref"), `id: ${effortDiveId}\n`);
	for (const [id, name] of [
		[alphaScopeRepoId, "alpha"],
		[betaScopeRepoId, "beta"],
		[gammaScopeRepoId, "gamma"],
		[duplicateScopeRepoIdA, "duplicate"],
		[duplicateScopeRepoIdB, "duplicate"],
	]) {
		write(
			join(addRepoFeatBridge, "kb", `${id}.md`),
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

	// A scope added with no branch is read-only, and says so by naming none.
	const addFeatByName = run(["add-repo.feat", "beta"], addRepoFeatBridge);
	assertOk(addFeatByName, "add-repo.feat by name failed");
	assert.match(
		addFeatByName.stdout,
		new RegExp(`Added scope ${betaScopeRepoId} to .*${effortId}\\.md`),
	);
	const effortAfterName = readFileSync(join(addRepoFeatBridge, "kb", `${effortId}.md`), "utf8");
	assert.match(effortAfterName, /custom: keep-me/);
	assert.match(effortAfterName, new RegExp(`^  - ${betaScopeRepoId}$`, "m"));
	assert.doesNotMatch(effortAfterName, new RegExp(`${betaScopeRepoId}:\\n\\s+ref:`));
	assert.doesNotMatch(effortAfterName, /^\s+mode: /m);
	assert.match(effortAfterName, /Do not rewrite this body\./);

	const addFeatWithModifiers = run(
		[
			"add-repo.feat",
			gammaScopeRepoId,
			"--ref",
			"release/candidate",
			"--work-branch",
			"work/feature",
		],
		addRepoFeatBridge,
	);
	assertOk(addFeatWithModifiers, "add-repo.feat with modifiers failed");
	const effortAfterModifiers = readFileSync(
		join(addRepoFeatBridge, "kb", `${effortId}.md`),
		"utf8",
	);
	assert.match(
		effortAfterModifiers,
		new RegExp(`${gammaScopeRepoId}:\\n\\s+ref: release/candidate\\n\\s+work-branch: work/feature`),
	);
	assert.doesNotMatch(effortAfterModifiers, /^\s+mode: /m);

	// The two flags are two answers to the same question.
	const bothAnswers = run(
		["add-repo.feat", "alpha", "--read-only", "--work-branch", "work/feature"],
		addRepoFeatBridge,
	);
	assert.notEqual(bothAnswers.status, 0, "--read-only with --work-branch unexpectedly succeeded");
	assert.match(bothAnswers.stderr, /--read-only cannot be combined with --work-branch/);

	// `add-repo.effort` is the superseded spelling and routes to the same place.
	const duplicateEffortAdd = run(["add-repo.effort", "beta"], addRepoFeatBridge);
	assert.notEqual(duplicateEffortAdd.status, 0, "duplicate add-repo.effort unexpectedly succeeded");
	assert.match(
		duplicateEffortAdd.stderr,
		new RegExp(`feat already includes scope ${betaScopeRepoId}`),
	);

	const ambiguousEffortAdd = run(["add-repo.effort", "duplicate"], addRepoFeatBridge);
	assert.notEqual(ambiguousEffortAdd.status, 0, "ambiguous add-repo.effort unexpectedly succeeded");
	assert.match(ambiguousEffortAdd.stderr, /repo name is ambiguous: duplicate/);
	assert.match(ambiguousEffortAdd.stderr, new RegExp(duplicateScopeRepoIdA));
	assert.match(ambiguousEffortAdd.stderr, new RegExp(duplicateScopeRepoIdB));

	rmSync(join(addRepoFeatBridge, "workspace", ".nosedive-ref"), { force: true });
	const addWithoutActiveEffort = run(["add-repo.effort", "alpha"], addRepoFeatBridge);
	assert.notEqual(
		addWithoutActiveEffort.status,
		0,
		"add-repo.effort without active effort unexpectedly succeeded",
	);
	assert.match(addWithoutActiveEffort.stderr, /no active dive/);
	assert.match(addWithoutActiveEffort.stderr, /workspace\/\.nosedive-ref/);
});
