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
const tmp = createTmp("cli-basics");
const noBridge = createNoBridge(tmp);

test("cli-basics", () => {
	const importOnly = spawnSync(
		process.execPath,
		["-e", `import(${JSON.stringify(pathToFileURL(lib).href)})`],
		{
			cwd: root,
			encoding: "utf8",
		},
	);
	assertOk(importOnly, "library import failed");
	assert.equal(importOnly.stdout, "", "library import unexpectedly wrote to stdout");
	assert.equal(importOnly.stderr, "", "library import unexpectedly wrote to stderr");

	const version = run(["version"], noBridge);
	assertOk(version, "version command failed");
	assert.match(version.stdout.trim(), /^(\d+\.\d+\.\d+(?:-\d+)?|0\.0\.0-dev)$/);

	const help = run(["--help"], noBridge);
	assertOk(help, "--help command failed");
	assert.match(help.stdout, /Usage: nosedive <command>/);
	assert.match(help.stdout, /Commands:/);
	assert.match(help.stdout, /mint/);
	assert.match(help.stdout, /seed/);
	assert.doesNotMatch(help.stdout, /^  init\b/m);
	assert.match(help.stdout, /preflight/);
	assert.match(help.stdout, /prove/);
	assert.match(help.stdout, /render/);
	assert.match(help.stdout, /pre-push\.hook/);
	assert.match(help.stdout, /whoami/);
	assert.match(help.stdout, /dump-backlog/);
	assert.match(help.stdout, /list-dives/);
	assert.match(help.stdout, /pitch/);
	assert.match(help.stdout, /hydrate-repo\.workspace/);
	assert.match(help.stdout, /dehydrate-repo\.workspace/);
	assert.match(help.stdout, /add-repo/);
	assert.match(help.stdout, /nuke/);
	assert.match(help.stdout, /seed\s+Create, migrate, or edit bridge config/);
	assert.match(help.stdout, /whoami\s+Returns dev-identifying fields from git config/);
	assert.doesNotMatch(help.stdout, /\b[a-z][\w.-]*@\d+\b/);
	assert.doesNotMatch(help.stdout, /_prove-host/);
	assert.match(help.stdout, /Run `nosedive <command> --help` for details on a command\./);

	const privateProveHostHelp = run(["_prove-host", "--help"], noBridge);
	assertOk(privateProveHostHelp, "_prove-host --help failed");
	assert.match(privateProveHostHelp.stdout, /Usage: nosedive _prove-host <request-json-path>/);

	const privateProveHostMissingRequest = run(["_prove-host"], noBridge);
	assert.notEqual(privateProveHostMissingRequest.status, 0, "_prove-host unexpectedly succeeded");
	assert.match(privateProveHostMissingRequest.stderr, /_prove-host requires one request path/);

	const minted = run(["mint", "1997-08-29T02:14:00-04:00", "2"], noBridge);
	assertOk(minted, "mint command failed");
	const mintedLines = minted.stdout.trim().split(/\r?\n/);
	assert.equal(mintedLines.length, 2, "mint should print one UUID per line");
	assert.match(
		mintedLines[0],
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.match(
		mintedLines[1],
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.equal(
		mintedLines[0] < mintedLines[1],
		true,
		"mint count mode should advance timestamps by 1ms and sort lexicographically",
	);

	const mintedNow = run(["mint"], noBridge);
	assertOk(mintedNow, "mint default timestamp command failed");
	assert.match(
		mintedNow.stdout.trim(),
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);

	const renderedHandoff = run(["render", handoffRunbookId], noBridge);
	assertOk(renderedHandoff, "render handoff runbook failed");
	assert.match(renderedHandoff.stdout, /^# Handoff/m);
	assert.match(renderedHandoff.stdout, /meta\.patch-artifacts/);
	assert.match(renderedHandoff.stdout, /dehydrate-repo\.workspace/);
	assert.doesNotMatch(renderedHandoff.stdout, /^---/);
	assert.doesNotMatch(renderedHandoff.stdout, /^kind: runbook/m);

	const missingRender = run(["render", "019f9f95-ffff-7fff-bfff-ffffffffffff"], noBridge);
	assert.notEqual(missingRender.status, 0, "render missing package doc unexpectedly succeeded");
	assert.match(missingRender.stderr, /package kb doc not found/);
});
