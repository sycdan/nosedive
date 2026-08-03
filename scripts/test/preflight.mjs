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
const tmp = createTmp("preflight");
const noBridge = createNoBridge(tmp);

test("preflight", () => {
	const preflightBridge = join(tmp, "preflight-bridge");
	mkdirSync(preflightBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], preflightBridge);
	writeBridgeConfig(preflightBridge, { backlog: "./backlog" });
	const preflight = run(["preflight"], preflightBridge);
	assertOk(preflight, "preflight install failed");
	const installedHook = join(preflightBridge, ".git", "hooks", "pre-push");
	assert.equal(
		readFileSync(installedHook, "utf8"),
		'#!/bin/sh\n# nosedive-managed\nexec npx nosedive _pre-push.hook "$@"\n',
	);
	assert.equal(readFileSync(installedHook).includes(Buffer.from("\r\n")), false);
	if (process.platform !== "win32") {
		assert.notEqual(statSync(installedHook).mode & 0o111, 0, "installed hook should be executable");
	}

	const preflightAgain = run(["preflight"], preflightBridge);
	assertOk(preflightAgain, "preflight idempotent refresh failed");
	assert.equal(
		readFileSync(installedHook, "utf8"),
		'#!/bin/sh\n# nosedive-managed\nexec npx nosedive _pre-push.hook "$@"\n',
	);

	const foreignHookBridge = join(tmp, "foreign-hook-bridge");
	mkdirSync(foreignHookBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], foreignHookBridge);
	writeBridgeConfig(foreignHookBridge, { backlog: "./backlog" });
	const foreignHook = join(foreignHookBridge, ".git", "hooks", "pre-push");
	const foreignHookText = "#!/bin/sh\necho user-hook\n";
	write(foreignHook, foreignHookText);
	const foreignPreflight = run(["preflight"], foreignHookBridge);
	assertOk(foreignPreflight, "preflight with foreign hook should warn but succeed");
	assert.equal(readFileSync(foreignHook, "utf8"), foreignHookText);
	assert.match(foreignPreflight.stderr, /foreign pre-push hook exists/);
	assert.match(foreignPreflight.stderr, /Add this line to your existing pre-push hook setup/);
	assert.match(foreignPreflight.stderr, /npx nosedive _pre-push\.hook "\$@" \|\| exit 1/);

	const hooksPathBridge = join(tmp, "hooks-path-bridge");
	mkdirSync(hooksPathBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], hooksPathBridge);
	runTool("git", ["config", "core.hooksPath", ".githooks"], hooksPathBridge);
	writeBridgeConfig(hooksPathBridge, { backlog: "./backlog" });
	const hooksPathPreflight = run(["preflight"], hooksPathBridge);
	assertOk(hooksPathPreflight, "preflight with core.hooksPath should warn but succeed");
	assert.equal(existsSync(join(hooksPathBridge, ".git", "hooks", "pre-push")), false);
	assert.equal(
		runTool("git", ["config", "--get", "core.hooksPath"], hooksPathBridge).stdout.trim(),
		".githooks",
	);
	assert.match(hooksPathPreflight.stderr, /core\.hooksPath is set/);
	assert.match(hooksPathPreflight.stderr, /Add this line to your existing pre-push hook setup/);
});
