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
	createBridge,
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
const tmp = createTmp("whoami");
const noBridge = createNoBridge(tmp);

test("whoami reports git identity", () => {
	const bridge = createBridge(tmp, "whoami-bridge", { backlog: "./backlog" });
	runTool("git", ["config", "user.name", "Contract Pilot"], bridge);
	runTool("git", ["config", "user.email", "contract@example.invalid"], bridge);

	const whoami = run(["whoami"], bridge);
	assertOk(whoami, "whoami command route failed");
	assert.equal(
		whoami.stdout,
		`nosedive-pilot-name: Contract Pilot
nosedive-pilot-email: contract@example.invalid
`,
	);
	assert.equal(whoami.stderr, "");

	const explicit = run(["whoami@1"], bridge);
	assertOk(explicit, "explicit whoami@1 command route failed");
	assert.equal(explicit.stdout, whoami.stdout);
	assert.equal(explicit.stderr, "");

	const missingLevel = run(["whoami@2"], bridge);
	assert.notEqual(
		missingLevel.status,
		0,
		"missing explicit whoami@2 command unexpectedly succeeded",
	);
	assert.match(missingLevel.stderr, /command not found: whoami@2/);
});

test("whoami reads identity from git, not bridge config", () => {
	const bridge = createBridge(tmp, "whoami-config-bridge", { backlog: "./backlog" });
	runTool("git", ["config", "user.name", "Git Pilot"], bridge);
	runTool("git", ["config", "user.email", "git-pilot@example.invalid"], bridge);
	write(
		join(bridge, ".nosedive", "config.yaml"),
		`${readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8")}pilot-name: Configured Pilot
pilot-email: configured@example.invalid
`,
	);

	const whoami = run(["whoami"], bridge);
	assertOk(whoami, "whoami with configured pilot fields failed");
	assert.equal(
		whoami.stdout,
		`nosedive-pilot-name: Git Pilot
nosedive-pilot-email: git-pilot@example.invalid
`,
	);
});

test("whoami fails when git identity is incomplete", () => {
	const bridge = createBridge(tmp, "whoami-unset-bridge", { backlog: "./backlog" });
	runTool("git", ["config", "user.name", "Only Git Name"], bridge);
	// Blank, not unset: the developer's global git config would otherwise supply one.
	runTool("git", ["config", "user.email", ""], bridge);

	const whoami = run(["whoami"], bridge);
	assert.notEqual(whoami.status, 0, "whoami with unset email unexpectedly succeeded");
	assert.equal(whoami.stdout, "");
	assert.match(whoami.stderr, /missing git config: user\.email/);
});

test("whoami needs no bridge", () => {
	const outside = join(tmp, "outside-any-bridge");
	mkdirSync(outside, { recursive: true });
	runTool("git", ["init", "-b", "main"], outside);
	runTool("git", ["config", "user.name", "Loose Pilot"], outside);
	runTool("git", ["config", "user.email", "loose@example.invalid"], outside);

	const whoami = run(["whoami"], outside);
	assertOk(whoami, "whoami outside a bridge failed");
	assert.match(whoami.stdout, /^nosedive-pilot-name: Loose Pilot$/m);
});
