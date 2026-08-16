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
	const featId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e001";
	const diveId = "019fbf74-9c6e-71a2-a3f2-f0c99be3e010";
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
		join(addRepoFeatBridge, "kb", `${featId}.md`),
		`---
kind: feat
id: ${featId}
name: feature
gist: "Feat for add-repo.feat tests."
custom: keep-me
scopes:
  - ${alphaScopeRepoId}:
      work-branch: work/feature
---

# Feature

Do not rewrite this body.
`,
	);
	// Deliberately the top-level `effort:` spelling, which `kbDocs.ts` still
	// accepts on read and this is the only fixture covering. `jump.mjs` covers
	// the `meta.effort` form; neither is ever written back.
	write(
		join(addRepoFeatBridge, "kb", `${diveId}.md`),
		`---
kind: dive
id: ${diveId}
name: feature.abcdef
gist: "Active dive for add-repo.feat tests."
effort: kb/${featId}.md
---

# Feature dive
`,
	);
	write(join(addRepoFeatBridge, "workspace", ".nosedive-ref"), `id: ${diveId}\n`);
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
		new RegExp(`Added scope ${betaScopeRepoId} to .*${featId}\\.md`),
	);
	const featAfterName = readFileSync(join(addRepoFeatBridge, "kb", `${featId}.md`), "utf8");
	assert.match(featAfterName, /custom: keep-me/);
	assert.match(featAfterName, new RegExp(`^  - ${betaScopeRepoId}$`, "m"));
	assert.doesNotMatch(featAfterName, new RegExp(`${betaScopeRepoId}:\\n\\s+ref:`));
	assert.doesNotMatch(featAfterName, /^\s+mode: /m);
	assert.match(featAfterName, /Do not rewrite this body\./);

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
	const featAfterModifiers = readFileSync(join(addRepoFeatBridge, "kb", `${featId}.md`), "utf8");
	assert.match(
		featAfterModifiers,
		new RegExp(`${gammaScopeRepoId}:\\n\\s+ref: release/candidate\\n\\s+work-branch: work/feature`),
	);
	assert.doesNotMatch(featAfterModifiers, /^\s+mode: /m);

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
	const addWithoutActiveDive = run(["add-repo.effort", "alpha"], addRepoFeatBridge);
	assert.notEqual(
		addWithoutActiveDive.status,
		0,
		"add-repo.effort without an active dive unexpectedly succeeded",
	);
	assert.match(addWithoutActiveDive.stderr, /no active dive/);
	assert.match(addWithoutActiveDive.stderr, /workspace\/\.nosedive-ref/);
});
