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
	bareRepo,
	cli,
	createNoBridge,
	createTmp,
	escapeRegExp,
	gitCommit,
	giveOrigin,
	gitCommonDir,
	handoffRunbookId,
	lib,
	libUrl,
	packageFoundationDocs,
	packageMigrationDoc,
	packageMigrationScript,
	packageNonFoundationDoc,
	packageVersionPattern,
	root,
	run,
	runGit,
	runGitUnchecked,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const { readKbDocById, readNosediveRc } = await import(libUrl);
const tmp = createTmp("seed-headless");
const noBridge = createNoBridge(tmp);
const quidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function emptyOriginBridge(name) {
	const bridge = join(tmp, name);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Seed Person"], bridge);
	runTool("git", ["config", "user.email", "seed@example.invalid"], bridge);
	const origin = bareRepo(tmp, `${name}-origin.git`);
	runTool("git", ["remote", "add", "origin", origin], bridge);
	return { bridge, origin };
}

function seedBridge(bridge) {
	return run(["seed", "--headless", "--file", "AGENTS.md"], bridge, "");
}

test("interactive seed prompts only for configurable paths and branch prefix", () => {
	const { bridge } = emptyOriginBridge("interactive-prompts");
	const seeded = run(["seed", "--file", "AGENTS.md"], bridge, "\n\n\n");
	assertOk(seeded, "interactive seed failed");
	assert.deepEqual(seeded.stdout.match(/[a-z-]+ \[[^\]]+\]: /g), [
		"workspace [./workspace]: ",
		"kb [./kb]: ",
		"work-branch-prefix [work/]: ",
	]);
	assert.doesNotMatch(seeded.stdout, /backlog \[/);
});

test("first seed publishes an empty origin and sets upstream", () => {
	const { bridge, origin } = emptyOriginBridge("first-publish");
	const seeded = seedBridge(bridge);
	assertOk(seeded, "first seed failed");
	assert.equal(runGit(["rev-list", "--count", "main"], origin).stdout.trim(), "1");
	assert.equal(
		runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], bridge).stdout.trim(),
		"origin/main",
	);
	assert.match(
		seeded.stdout,
		new RegExp(
			`^Committed seed\\(nosedive@${packageVersionPattern}\\): surface changed to [0-9a-f]+$`,
			"m",
		),
	);
	assert.match(seeded.stdout, /^Pushed to origin\/main$/m);
	assert.doesNotMatch(seeded.stdout, /^git /m);
});

test("seed commits only its own files", () => {
	const { bridge } = emptyOriginBridge("only-seed-files");
	write(join(bridge, "notes.md"), "committed\n");
	runTool("git", ["add", "notes.md"], bridge);
	gitCommit(bridge, "pilot base");
	write(join(bridge, "notes.md"), "dirty\n");
	write(join(bridge, "draft.md"), "untracked\n");

	assertOk(seedBridge(bridge), "seed with unrelated work failed");
	const committedPaths = runGit(["show", "--pretty=format:", "--name-only", "HEAD"], bridge).stdout;
	assert.doesNotMatch(committedPaths, /^notes\.md$/m);
	assert.doesNotMatch(committedPaths, /^draft\.md$/m);
	assert.match(runGit(["status", "--short"], bridge).stdout, /^ M notes\.md$/m);
	assert.match(runGit(["status", "--short"], bridge).stdout, /^\?\? draft\.md$/m);
});

test("unchanged re-seed is silent and does not publish a commit", () => {
	const { bridge, origin } = emptyOriginBridge("unchanged-reseed");
	assertOk(seedBridge(bridge), "first seed failed");
	const before = runGit(["rev-parse", "main"], origin).stdout.trim();
	const reseeded = seedBridge(bridge);
	assertOk(reseeded, "unchanged re-seed failed");
	assert.equal(runGit(["rev-parse", "main"], origin).stdout.trim(), before);
	assert.match(reseeded.stdout, /^Bridge was already up to date; nothing was committed$/m);
	assert.doesNotMatch(reseeded.stdout, /^git /m);
});

test("managed instruction drift commits and pushes a changed surface", () => {
	const { bridge, origin } = emptyOriginBridge("surface-drift");
	assertOk(seedBridge(bridge), "first seed failed");
	const preflight = run(["preflight"], bridge, "");
	assertOk(preflight, "preflight failed to install the pre-push hook");
	const instructionsPath = join(bridge, "AGENTS.md");
	writeFileSync(
		instructionsPath,
		readFileSync(instructionsPath, "utf8").replace(
			"- `nosedive` commands may issue instructions",
			"- drifted instructions may issue instructions",
		),
		"utf8",
	);
	runTool("git", ["add", "AGENTS.md"], bridge);
	gitCommit(bridge, "simulate published instruction drift");
	runTool("git", ["push"], bridge);
	const before = runGit(["rev-parse", "main"], origin).stdout.trim();

	const reseeded = seedBridge(bridge);
	assertOk(reseeded, "re-seed after instruction drift failed");
	const subject = runGit(["log", "-1", "--pretty=%s"], bridge).stdout.trim();
	assert.match(
		subject,
		new RegExp(`^seed\\(nosedive@${packageVersionPattern}\\): surface changed to [0-9a-f]+$`),
	);
	assert.notEqual(runGit(["rev-parse", "main"], origin).stdout.trim(), before);
	assert.equal(reseeded.stderr, "");
});

test("seed preserves a pilot's staged work", () => {
	const { bridge } = emptyOriginBridge("staged-pilot-work");
	write(join(bridge, "notes.md"), "committed\n");
	runTool("git", ["add", "notes.md"], bridge);
	gitCommit(bridge, "pilot base");
	write(join(bridge, "notes.md"), "staged\n");
	runTool("git", ["add", "notes.md"], bridge);

	assertOk(seedBridge(bridge), "seed with staged pilot work failed");
	assert.match(runGit(["diff", "--cached", "--name-only"], bridge).stdout, /^notes\.md$/m);
	assert.equal(runGit(["show", "HEAD:notes.md"], bridge).stdout, "committed\n");
});

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
	giveOrigin(tmp, headlessFreshBridge, "headless-fresh-bridge");

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
	const freshBridgeId = /^bridge: (\S+)$/m.exec(freshConfig)?.[1];
	assert.match(freshMemoId ?? "", quidPattern, "fresh seed should mint a backlog memo id");
	assert.match(freshBridgeId ?? "", quidPattern, "fresh seed should mint a bridge repo id");
	assert.equal(
		freshConfig,
		[
			"compatibility-level: 2",
			"workspace: ./workspace",
			`backlog: ${freshMemoId}`,
			"kb: ./kb",
			`bridge: ${freshBridgeId}`,
			"work-branch-prefix: work/",
			"",
		].join("\n"),
	);
	const freshMemo = readFileSync(join(headlessFreshBridge, "kb", `${freshMemoId}.md`), "utf8");
	assert.match(freshMemo, /^kind: memo$/m);
	assert.match(freshMemo, /^name: backlog\.headless-fresh-bridge$/m);
	assert.match(freshMemo, /^# Backlog$/m);
	assert.equal(existsSync(join(headlessFreshBridge, ".nosedive.local.yaml")), false);
	assert.equal(
		readFileSync(join(headlessFreshBridge, ".nosedive", ".gitignore"), "utf8"),
		["cache/", "migration-backups/", ""].join("\n"),
	);
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
	giveOrigin(tmp, headlessExistingBridge, "headless-existing-bridge");
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
	const existingBridgeId = /^bridge: (\S+)$/m.exec(existingConfig)?.[1];
	assert.match(
		existingMemoId ?? "",
		quidPattern,
		"seed should mint a backlog memo id when migration produced none",
	);
	assert.match(existingBridgeId ?? "", quidPattern, "seed should mint a bridge repo id");
	assert.equal(
		existingConfig,
		[
			"compatibility-level: 2",
			"workspace: ./custom-workspace",
			`backlog: ${existingMemoId}`,
			"kb: ./custom-kb",
			`bridge: ${existingBridgeId}`,
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

test("seed pushes the trunk resolved from git", () => {
	const bridge = join(tmp, "master-bridge");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "master"], bridge);
	giveOrigin(tmp, bridge, "master-bridge", "master");

	const result = run(["seed", "--headless", "--file", "AGENTS.md"], bridge, "");
	assertOk(result, "seed on master failed");
	assert.equal(
		runGit(["rev-parse", "--abbrev-ref", "@{upstream}"], bridge).stdout.trim(),
		"origin/master",
	);
});

test("seed removes home-branch and preserves unowned config", () => {
	const bridge = join(tmp, "old-home-branch");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	giveOrigin(tmp, bridge, "old-home-branch");
	const runnerId = "019ff32a-d05f-77d7-ad63-5da2c22d0418";
	write(
		join(bridge, ".nosedive", "config.yaml"),
		[
			"compatibility-level: 2",
			"workspace: ./workspace",
			"backlog: ./backlog",
			"kb: ./kb",
			"home-branch: main",
			"work-branch-prefix: work/",
			`agent-runner: ${runnerId}`,
			"",
		].join("\n"),
	);

	const result = run(["seed", "--headless", "--file", "AGENTS.md"], bridge, "");
	assertOk(result, "re-seed with home-branch failed");
	const config = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	assert.doesNotMatch(config, /^home-branch:/m);
	assert.match(/^bridge: (\S+)$/m.exec(config)?.[1] ?? "", quidPattern);
	assert.match(config, new RegExp(`^agent-runner: ${runnerId}$`, "m"));
});

test("re-seed reuses the bridge repo document", () => {
	const bridge = join(tmp, "reseed-bridge");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	giveOrigin(tmp, bridge, "reseed-bridge");

	const firstSeed = run(["seed", "--headless", "--file", "AGENTS.md"], bridge, "");
	assertOk(firstSeed, "first seed for re-seed test failed");
	const firstConfig = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const firstBridgeId = /^bridge: (\S+)$/m.exec(firstConfig)?.[1];
	assert.match(firstBridgeId ?? "", quidPattern, "first seed should record a bridge repo id");

	const secondSeed = run(["seed", "--headless", "--file", "AGENTS.md"], bridge, "");
	assertOk(secondSeed, "second seed for re-seed test failed");
	const secondConfig = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	assert.equal(/^bridge: (\S+)$/m.exec(secondConfig)?.[1], firstBridgeId);

	const selfRepoDocs = readdirSync(join(bridge, "kb"))
		.filter((name) => name.endsWith(".md"))
		.map((name) => readFileSync(join(bridge, "kb", name), "utf8"))
		.filter((text) => /^kind: repo$/m.test(text) && /^\s+path: "workspace\/__self"$/m.test(text));
	assert.equal(selfRepoDocs.length, 1);
});

test("readKbDocById refuses a filename whose document declares another id", () => {
	const bridge = join(tmp, "lying-kb-doc");
	const requestedId = "019ff32a-d05f-77d7-ad63-5da2c22d0418";
	const declaredId = "01a02ae5-b7e9-7124-aaeb-ce8bca36564e";
	const path = join(bridge, "kb", `${requestedId}.md`);
	write(path, `---\nkind: memo\nid: ${declaredId}\n---\n`);

	assert.throws(
		() => readKbDocById(join(bridge, "kb"), bridge, requestedId),
		(error) => {
			assert.match(error.message, new RegExp(`${requestedId}\\.md`));
			assert.match(error.message, new RegExp(`declares id ${declaredId}`));
			return true;
		},
	);
});
