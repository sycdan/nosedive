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
	createBridge,
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
	assert.match(help.stdout, /whoami/);
	assert.match(help.stdout, /dump-backlog/);
	assert.doesNotMatch(help.stdout, /list-dives/);
	assert.match(help.stdout, /pitch/);
	assert.match(help.stdout, /hydrate-repo\.workspace/);
	assert.match(help.stdout, /dehydrate-repo\.workspace/);
	assert.match(help.stdout, /add-repo/);
	assert.match(help.stdout, /nuke/);
	assert.match(help.stdout, /seed\s+Create, migrate, or edit bridge config/);
	assert.match(help.stdout, /whoami\s+Returns dev-identifying fields from git config/);
	assert.doesNotMatch(help.stdout, /\b[a-z][\w.-]*@\d+\b/);
	assert.doesNotMatch(help.stdout, /_prove-host/);
	assert.doesNotMatch(help.stdout, /pre-push\.hook/);
	assert.match(help.stdout, /Run `nosedive <command> --help` for details on a command\./);

	const privateProveHostHelp = run(["_prove-host", "--help"], noBridge);
	assertOk(privateProveHostHelp, "_prove-host --help failed");
	assert.match(privateProveHostHelp.stdout, /Usage: nosedive _prove-host <request-json-path>/);

	const privateProveHostMissingRequest = run(["_prove-host"], noBridge);
	assert.notEqual(privateProveHostMissingRequest.status, 0, "_prove-host unexpectedly succeeded");
	assert.match(privateProveHostMissingRequest.stderr, /_prove-host requires one request path/);

	const uuid7Shape = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	const encodedMs = (id) => Number.parseInt(`${id.slice(0, 8)}${id.slice(9, 13)}`, 16);

	const isoStart = "1997-08-29T02:14:00-04:00";
	const minted = run(["mint", "2", "--ts", isoStart], noBridge);
	assertOk(minted, "mint command failed");
	const mintedLines = minted.stdout.trim().split(/\r?\n/);
	assert.equal(mintedLines.length, 2, "mint should print one UUID per line");
	assert.match(mintedLines[0], uuid7Shape);
	assert.match(mintedLines[1], uuid7Shape);
	assert.equal(encodedMs(mintedLines[0]), Date.parse(isoStart), "--ts should set the start point");
	assert.equal(
		encodedMs(mintedLines[1]) - encodedMs(mintedLines[0]),
		1,
		"mint count mode should advance the encoded timestamp by 1ms per id",
	);
	assert.equal(
		mintedLines[0] < mintedLines[1],
		true,
		"mint count mode should sort lexicographically",
	);

	const mintedMs = run(["mint", "3", "--ms=872835240000"], noBridge);
	assertOk(mintedMs, "mint --ms failed");
	const mintedMsLines = mintedMs.stdout.trim().split(/\r?\n/);
	assert.deepEqual(
		mintedMsLines.map(encodedMs),
		[872835240000, 872835240001, 872835240002],
		"--ms should set the start point and advance by 1ms per id",
	);

	const mintedNow = run(["mint"], noBridge);
	assertOk(mintedNow, "mint default timestamp command failed");
	assert.match(mintedNow.stdout.trim(), uuid7Shape);

	const mintedBothStarts = run(["mint", "--ms", "0", "--ts", isoStart], noBridge);
	assert.notEqual(mintedBothStarts.status, 0, "mint unexpectedly accepted --ms with --ts");
	assert.match(mintedBothStarts.stderr, /--ms and --ts are exclusive/);

	const mintedBadOption = run(["mint", "--when", isoStart], noBridge);
	assert.notEqual(mintedBadOption.status, 0, "mint unexpectedly accepted an unknown option");
	assert.match(mintedBadOption.stderr, /unknown mint option: --when/);

	const mintedBadCount = run(["mint", isoStart], noBridge);
	assert.notEqual(mintedBadCount.status, 0, "mint unexpectedly accepted a non-numeric count");
	assert.match(mintedBadCount.stderr, /invalid count/);

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

/**
 * A level is exercised before any bridge has migrated to it, so an explicit
 * `@N` has to keep working past the refusal that catches the plain route. It
 * still has to say it is off the supported path.
 */
test("explicit @N runs ahead of the bridge with a warning", () => {
	const backlogId = "00000000-0000-7000-8000-0000000000a1";
	const backlogMemo = [
		"---",
		"kind: memo",
		`id: ${backlogId}`,
		"name: ahead-of-bridge-backlog",
		'gist: "Backlog memo."',
		"---",
		"",
		"# Ahead Of Bridge Backlog",
		"",
	].join("\n");

	const staleBridge = join(tmp, "ahead-of-bridge");
	mkdirSync(staleBridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], staleBridge);
	write(
		join(staleBridge, ".nosedive", "config.yaml"),
		[
			"compatibility-level: 1",
			"workspace: ./workspace",
			"kb: ./kb",
			`backlog: ${backlogId}`,
			"",
		].join("\n"),
	);
	write(join(staleBridge, "kb", `${backlogId}.md`), backlogMemo);

	// L1 -> L2 has no migration, so the plain route is not refused at all.
	const plain = run(["dump-backlog"], staleBridge);
	assertOk(plain, "plain route refused a bridge with no migration in the gap");

	const ahead = run(["dump-backlog@2"], staleBridge);
	assertOk(ahead, "explicit dump-backlog@2 failed against a level 1 bridge");
	assert.match(
		ahead.stderr,
		/nosedive: warning: dump-backlog@2 is ahead of this bridge \(level 1\); running a command ahead of the bridge is not an officially-supported pathway/,
	);
	assert.match(ahead.stdout, /^# Ahead Of Bridge Backlog$/m, "dump-backlog@2 produced no output");

	// At or behind the bridge is the ordinary route, and stays quiet.
	const behind = run(["dump-backlog@1"], staleBridge);
	assertOk(behind, "explicit dump-backlog@1 failed against a level 1 bridge");
	assert.doesNotMatch(behind.stderr, /ahead of this bridge/);

	const currentBridge = createBridge(tmp, "ahead-of-bridge-current", { backlog: backlogId });
	write(join(currentBridge, "kb", `${backlogId}.md`), backlogMemo);
	const atLevel = run(["dump-backlog@2"], currentBridge);
	assertOk(atLevel, "explicit dump-backlog@2 failed against a level 2 bridge");
	assert.doesNotMatch(atLevel.stderr, /ahead of this bridge/);

	// No bridge to be ahead of, so nothing to warn about.
	const outside = run(["mint@1"], noBridge);
	assertOk(outside, "explicit mint@1 outside a bridge failed");
	assert.doesNotMatch(outside.stderr, /ahead of this bridge/);
});
