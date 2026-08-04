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
const tmp = createTmp("seed-headless");
const noBridge = createNoBridge(tmp);

test("seed-headless", () => {
	const seedHelp = run(["seed", "--help"], noBridge);
	assertOk(seedHelp, "seed --help failed");
	assert.match(seedHelp.stdout, /Usage: nosedive seed \[--file <path>\]\.\.\. \[--headless\]/);
	assert.match(
		seedHelp.stdout,
		/Usage: nosedive seed \[--file <path>\]\.\.\. \[--headless\]\n\nCreate, migrate, or edit bridge config/,
	);

	const initHelp = run(["init", "--help"], noBridge);
	assert.notEqual(initHelp.status, 0, "init unexpectedly still exists");
	assert.match(initHelp.stderr, /Unknown command: init/);

	const unknownSeedOption = run(["seed", "--bogus"], root, "");
	assert.notEqual(unknownSeedOption.status, 0, "seed with unknown option unexpectedly succeeded");
	assert.match(unknownSeedOption.stderr, /unknown seed option: --bogus/);

	const wroteConfigFile = /Wrote \.nosedive\/config\.yaml/;

	const headlessFreshBridge = join(tmp, "headless-fresh-bridge");
	mkdirSync(headlessFreshBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], headlessFreshBridge);
	runTool("git", ["config", "user.name", "Headless Person"], headlessFreshBridge);
	runTool("git", ["config", "user.email", "headless@example.invalid"], headlessFreshBridge);

	const initHeadlessFresh = run(
		["seed", "--headless", "--file", "AGENTS.md"],
		headlessFreshBridge,
		"",
	);
	assertOk(initHeadlessFresh, "headless init on empty directory failed");
	assert.doesNotMatch(initHeadlessFresh.stdout, /workspace \[/);
	assert.match(initHeadlessFresh.stdout, wroteConfigFile);
	assert.doesNotMatch(initHeadlessFresh.stdout, /\.nosedive\.local\.yaml/);
	assert.doesNotMatch(initHeadlessFresh.stdout, /Seeded .*foundation docs/);
	// A fresh bridge gets its own backlog memo, so `backlog:` is a kb doc id
	// rather than a directory the way it was at L0.
	const freshConfig = readFileSync(join(headlessFreshBridge, ".nosedive", "config.yaml"), "utf8");
	const freshMemoId = /^backlog: (\S+)$/m.exec(freshConfig)?.[1];
	assert.match(
		freshMemoId ?? "",
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		"fresh seed should mint a backlog memo id",
	);
	assert.equal(
		freshConfig,
		[
			"compatibility-level: 1",
			"workspace: ./workspace",
			`backlog: ${freshMemoId}`,
			"kb: ./kb",
			"home-branch: main",
			"work-branch-prefix: work/",
			"",
		].join("\n"),
	);
	const freshMemo = readFileSync(join(headlessFreshBridge, "kb", `${freshMemoId}.md`), "utf8");
	assert.match(freshMemo, /^kind: memo$/m);
	assert.match(freshMemo, /^name: backlog\.headless-fresh-bridge$/m);
	assert.match(freshMemo, /^# Backlog$/m);
	assert.equal(existsSync(join(headlessFreshBridge, ".nosedive.local.yaml")), false);
	for (const packageFoundationDoc of packageFoundationDocs) {
		assert.equal(existsSync(join(headlessFreshBridge, "kb", packageFoundationDoc)), false);
	}
	const headlessFreshExclude = readFileSync(
		join(headlessFreshBridge, ".git", "info", "exclude"),
		"utf8",
	);
	assert.doesNotMatch(headlessFreshExclude, /^\.nosedive\.local\.yaml$/m);
	for (const packageFoundationDoc of packageFoundationDocs) {
		assert.doesNotMatch(headlessFreshExclude, new RegExp(`^kb/${packageFoundationDoc}$`, "m"));
	}

	// A legacy single-file bridge is auto-migrated to the split shape before
	// headless seed resolves and (re)writes settings -- this is the scenario
	// an agent hits running `seed --headless` at session start on an
	// old bridge.
	const headlessExistingBridge = join(tmp, "headless-existing-bridge");
	mkdirSync(headlessExistingBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], headlessExistingBridge);
	runTool("git", ["config", "user.name", "Detected Name"], headlessExistingBridge);
	runTool("git", ["config", "user.email", "detected@example.invalid"], headlessExistingBridge);
	write(
		join(headlessExistingBridge, ".nosediverc"),
		`workspace: ./custom-workspace
kb: ./custom-kb
pilot-name: Existing Pilot
agents:
  - claude
current:
  effort: some-effort/SomeEffort.md
`,
	);

	const initHeadlessExisting = run(
		["seed", "--headless", "--file", "AGENTS.md"],
		headlessExistingBridge,
		"",
	);
	assertOk(initHeadlessExisting, "headless init with existing legacy config failed");
	assert.doesNotMatch(initHeadlessExisting.stdout, /workspace \[/);
	assert.doesNotMatch(initHeadlessExisting.stdout, /Seeded .*foundation docs/);
	assert.match(
		initHeadlessExisting.stdout,
		/Running migration .*019f916b-f800-723d-b096-07d4300ff28a\.md/,
	);
	assert.match(
		initHeadlessExisting.stdout,
		/Migration 019f916b-f800-723d-b096-07d4300ff28a complete\./,
	);
	assert.equal(existsSync(join(headlessExistingBridge, ".nosediverc")), false);
	// This legacy bridge carried no backlog directory, so the migration had no
	// memo to build and seed mints an empty one.
	const existingConfig = readFileSync(
		join(headlessExistingBridge, ".nosedive", "config.yaml"),
		"utf8",
	);
	const existingMemoId = /^backlog: (\S+)$/m.exec(existingConfig)?.[1];
	assert.match(
		existingMemoId ?? "",
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		"seed should mint a backlog memo id when migration produced none",
	);
	assert.equal(
		existingConfig,
		[
			"compatibility-level: 1",
			"workspace: ./custom-workspace",
			`backlog: ${existingMemoId}`,
			"kb: ./custom-kb",
			"home-branch: main",
			"work-branch-prefix: work/",
			"",
		].join("\n"),
	);
	assert.equal(existsSync(join(headlessExistingBridge, ".nosedive.local.yaml")), false);
	for (const packageFoundationDoc of packageFoundationDocs) {
		assert.equal(
			existsSync(join(headlessExistingBridge, "custom-kb", packageFoundationDoc)),
			false,
		);
	}
	const headlessExistingExclude = readFileSync(
		join(headlessExistingBridge, ".git", "info", "exclude"),
		"utf8",
	);
	assert.doesNotMatch(headlessExistingExclude, /^\.nosedive\.local\.yaml$/m);
	for (const packageFoundationDoc of packageFoundationDocs) {
		assert.doesNotMatch(
			headlessExistingExclude,
			new RegExp(`^custom-kb/${packageFoundationDoc}$`, "m"),
		);
	}
	// Re-running seed on an already-migrated, already-current bridge is a
	// no-op with respect to migration.
	const initHeadlessAgain = run(
		["seed", "--headless", "--file", "AGENTS.md"],
		headlessExistingBridge,
		"",
	);
	assertOk(initHeadlessAgain, "second headless init on migrated bridge failed");
	assert.doesNotMatch(initHeadlessAgain.stdout, /Running migration/);
});
