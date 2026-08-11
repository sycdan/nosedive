import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
	assertOk,
	createBridge,
	createTmp,
	escapeRegExp,
	run,
	runTool,
	write,
	writeBridgeConfig,
	cli,
} from "../test-helpers.mjs";

const tmp = createTmp("preflight");

const NOSEDIVE_INVOCATION = `node ${cli.replaceAll("\\", "/")}`;
const MANAGED_HOOK = `#!/bin/sh\n# nosedive-managed\nexec ${NOSEDIVE_INVOCATION} _pre-push.hook "$@"\n`;

function freshGitBridge(name) {
	const bridge = join(tmp, name);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	return bridge;
}

function setIdentity(bridge, name, email) {
	runTool("git", ["config", "user.name", name], bridge);
	runTool("git", ["config", "user.email", email], bridge);
}

test("preflight installs and refreshes the managed hook, then reports with no active dive", () => {
	const bridge = freshGitBridge("install-bridge");
	setIdentity(bridge, "Install Pilot", "install-pilot@example.invalid");
	writeBridgeConfig(bridge, { backlog: "./backlog" });

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight install failed");
	const installedHook = join(bridge, ".git", "hooks", "pre-push");
	assert.equal(readFileSync(installedHook, "utf8"), MANAGED_HOOK);
	assert.equal(readFileSync(installedHook).includes(Buffer.from("\r\n")), false);
	if (process.platform !== "win32") {
		assert.notEqual(statSync(installedHook).mode & 0o111, 0, "installed hook should be executable");
	}
	assert.match(preflight.stdout, /^Installed nosedive pre-push hook:/m);

	// Session report: no active dive, and `backlog: ./backlog` is not UUID-shaped.
	assert.match(preflight.stdout, /^== bridge status ==$/m);
	const workspaceLine = /^nosedive-workspace: (.+)$/m.exec(preflight.stdout)?.[1];
	assert.ok(workspaceLine, `missing nosedive-workspace line:\n${preflight.stdout}`);
	assert.equal(workspaceLine.includes("\\"), false, "workspace path should be posix-formatted");
	assert.ok(
		workspaceLine.endsWith(`${basename(bridge)}/workspace`),
		`unexpected workspace line: ${workspaceLine}`,
	);
	assert.doesNotMatch(preflight.stdout, /nosedive-current-dive-id/);
	assert.doesNotMatch(preflight.stdout, /nosedive-current-effort/);
	assert.match(preflight.stdout, /^== pilot identification ==$/m);
	assert.match(preflight.stdout, /^nosedive-pilot-name: Install Pilot$/m);
	assert.match(preflight.stdout, /^nosedive-pilot-email: install-pilot@example\.invalid$/m);
	assert.match(preflight.stdout, /^== open work: current effort backlog ==$/m);
	assert.match(preflight.stderr, /dump-backlog requires a UUID-shaped backlog memo id/);

	const preflightAgain = run(["preflight"], bridge);
	assertOk(preflightAgain, "preflight idempotent refresh failed");
	assert.equal(readFileSync(installedHook, "utf8"), MANAGED_HOOK);
});

test("preflight streams its first line before the CLI exits", async () => {
	const bridge = freshGitBridge("streaming");
	setIdentity(bridge, "Streaming Pilot", "streaming-pilot@example.invalid");
	writeBridgeConfig(bridge, { backlog: "./backlog" });

	const child = spawn(process.execPath, [cli, "preflight"], { cwd: bridge });
	let exited = false;
	let firstLineBeforeExit = false;
	child.stdout.once("data", (chunk) => {
		firstLineBeforeExit =
			!exited && chunk.toString().startsWith("Installed nosedive pre-push hook:");
	});
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => {
			exited = true;
		});
		child.once("close", resolve);
	});
	assert.equal(firstLineBeforeExit, true, "preflight output arrived only after the CLI exited");
});

test("preflight hard-fails on an unwired foreign hook", () => {
	const bridge = freshGitBridge("foreign-hook-bridge");
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	const foreignHook = join(bridge, ".git", "hooks", "pre-push");
	const foreignHookText = "#!/bin/sh\necho user-hook\n";
	write(foreignHook, foreignHookText);

	const foreignPreflight = run(["preflight"], bridge);
	assert.notEqual(foreignPreflight.status, 0, "preflight with an unwired foreign hook should fail");
	assert.equal(readFileSync(foreignHook, "utf8"), foreignHookText);
	assert.match(foreignPreflight.stderr, /foreign pre-push hook exists/);
	assert.match(foreignPreflight.stderr, /Add this line to your existing pre-push hook setup/);
	assert.match(
		foreignPreflight.stderr,
		new RegExp(`${escapeRegExp(NOSEDIVE_INVOCATION)} _pre-push\\.hook "\\$@" \\|\\| exit 1`),
	);
	assert.equal(
		foreignPreflight.stdout,
		"",
		"no session report should print when the hook is unwired",
	);
});

test("preflight leaves a wired foreign hook untouched and reports", () => {
	const bridge = createBridge(tmp, "foreign-wired-bridge");
	setIdentity(bridge, "Wired Pilot", "wired-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	const foreignHook = join(bridge, ".git", "hooks", "pre-push");
	const wiredHookText =
		'#!/bin/sh\n# hand-rolled hook\nexec my-nosedive-alias _pre-push.hook "$@"\n';
	write(foreignHook, wiredHookText);

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with a wired foreign hook should succeed");
	assert.equal(readFileSync(foreignHook, "utf8"), wiredHookText);
	assert.equal(preflight.stderr, "", `unexpected stderr:\n${preflight.stderr}`);
	assert.match(preflight.stdout, /^== bridge status ==$/m);
	assert.match(preflight.stdout, /^== pilot identification ==$/m);
	assert.match(preflight.stdout, /^== open work: current effort backlog ==$/m);
});

test("preflight hard-fails when core.hooksPath names no wired hook", () => {
	const bridge = freshGitBridge("hooks-path-bridge");
	runTool("git", ["config", "core.hooksPath", ".githooks"], bridge);
	writeBridgeConfig(bridge, { backlog: "./backlog" });

	const hooksPathPreflight = run(["preflight"], bridge);
	assert.notEqual(
		hooksPathPreflight.status,
		0,
		"preflight with an unwired core.hooksPath should fail",
	);
	assert.equal(existsSync(join(bridge, ".git", "hooks", "pre-push")), false);
	assert.equal(
		runTool("git", ["config", "--get", "core.hooksPath"], bridge).stdout.trim(),
		".githooks",
	);
	assert.match(hooksPathPreflight.stderr, /core\.hooksPath is set/);
	assert.match(hooksPathPreflight.stderr, /Add this line to your existing pre-push hook setup/);
	assert.equal(hooksPathPreflight.stdout, "");
});

test("preflight leaves a wired core.hooksPath hook untouched and reports", () => {
	const bridge = freshGitBridge("hooks-path-wired-bridge");
	setIdentity(bridge, "Hooks Path Pilot", "hooks-path-pilot@example.invalid");
	runTool("git", ["config", "core.hooksPath", ".githooks"], bridge);
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	write(
		join(bridge, ".githooks", "pre-push"),
		'#!/bin/sh\nexec npx -y nosedive@2026.1.1-0 _pre-push.hook "$@"\n',
	);

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with a wired core.hooksPath hook should succeed");
	assert.equal(existsSync(join(bridge, ".git", "hooks", "pre-push")), false);
	assert.doesNotMatch(preflight.stderr, /WARNING/);
	assert.match(preflight.stdout, /^== bridge status ==$/m);
});

test("preflight reports bridge status, pilot identity, and the active dive/effort/backlog", () => {
	const bridge = createBridge(tmp, "report-bridge");
	setIdentity(bridge, "Report Pilot", "report-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	const pitched = run(["pitch", "Report the dive.", "--name", "report-effort"], bridge);
	assertOk(pitched, "pitch failed");
	const effortPath = /^Pitched (.+)$/m.exec(pitched.stdout)[1];
	const effortId = /^id: (\S+)$/m.exec(readFileSync(join(bridge, effortPath), "utf8"))[1];

	const recorded = run(
		["record.dive", "--effort", effortId, "--diver", "report-pilot@example.invalid"],
		bridge,
	);
	assertOk(recorded, "record.dive failed");
	const divePath = /^Recorded (.+)$/m.exec(recorded.stdout)[1];
	const diveText = readFileSync(join(bridge, divePath), "utf8");
	const diveId = /^id: (\S+)$/m.exec(diveText)[1];
	const diveGist = /^gist: "(.+)"$/m.exec(diveText)[1];
	assert.equal(readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"), `id: ${diveId}\n`);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight report failed");

	const bridgeIdx = preflight.stdout.indexOf("== bridge status ==");
	const pilotIdx = preflight.stdout.indexOf("== pilot identification ==");
	const backlogIdx = preflight.stdout.indexOf("== open work: current effort backlog ==");
	assert.ok(
		bridgeIdx !== -1 && bridgeIdx < pilotIdx && pilotIdx < backlogIdx,
		`sections missing or out of order:\n${preflight.stdout}`,
	);

	const workspaceLine = /^nosedive-workspace: (.+)$/m.exec(preflight.stdout)?.[1];
	assert.ok(workspaceLine, `missing nosedive-workspace line:\n${preflight.stdout}`);
	assert.equal(workspaceLine.includes("\\"), false, "workspace path should be posix-formatted");
	assert.ok(workspaceLine.endsWith(`${basename(bridge)}/workspace`));

	assert.match(
		preflight.stdout,
		new RegExp(`^nosedive-current-dive-id: ${escapeRegExp(diveId)}$`, "m"),
	);
	assert.match(
		preflight.stdout,
		new RegExp(`^nosedive-current-dive-gist: ${escapeRegExp(diveGist)}$`, "m"),
	);
	assert.match(
		preflight.stdout,
		new RegExp(`^nosedive-current-effort: ${escapeRegExp(effortId)}$`, "m"),
	);
	assert.match(preflight.stdout, /^nosedive-pilot-name: Report Pilot$/m);
	assert.match(preflight.stdout, /^nosedive-pilot-email: report-pilot@example\.invalid$/m);
	assert.match(preflight.stdout, /Report the dive\./);
});

const BARE_DIVE_ID = "019fe500-0000-7000-8000-00000000dead";
const FRAMED_DIVE_ID = "019fe500-0000-7000-8000-00000000beef";

test("preflight lists every dive with computed tags, split by pickup-ability", () => {
	const bridge = createBridge(tmp, "dives-bridge");
	setIdentity(bridge, "Dive Pilot", "dive-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	// Shaped like `record.dive --free` leaves one: named by its own id, no gist,
	// no brief, and `diver: null` rather than an absent key.
	write(
		join(bridge, "kb", `${BARE_DIVE_ID}.md`),
		[
			"---",
			"kind: dive",
			`id: ${BARE_DIVE_ID}`,
			`name: ${BARE_DIVE_ID}`,
			"meta:",
			"  diver: null",
			"---",
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${FRAMED_DIVE_ID}.md`),
		[
			"---",
			"kind: dive",
			`id: ${FRAMED_DIVE_ID}`,
			"name: framed-dive",
			'gist: "A dive with everything filled in."',
			"scopes:",
			"  - 019f514e-d8d5-7bc1-bf3f-d8e5092c6596:",
			"      mode: rw",
			"meta:",
			"  diver: dive-pilot@example.invalid",
			"---",
			"",
			"# Dive Record",
			"",
			"## Brief",
			"",
			"Do the thing.",
			"",
			"## 2026-08-09T05:02:49.670Z",
			"",
			"- repo=nosedive path=workspace/nosedive mode=rw ref=deadbee",
			"",
		].join("\n"),
	);
	// Only the framed one is committed, so `local-only` separates them.
	runTool("git", ["add", "--", `kb/${FRAMED_DIVE_ID}.md`], bridge);
	runTool("git", ["commit", "-m", "commit the framed dive"], bridge);

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with dives failed");
	assert.match(preflight.stdout, /^== dives ==$/m);

	const bare = new RegExp(
		`^ {2}- \\[${escapeRegExp(BARE_DIVE_ID)}\\]\\(${escapeRegExp(`kb/${BARE_DIVE_ID}.md`)}\\) needs=name,gist,brief,scopes,diver never-jumped local-only$`,
		"m",
	);
	assert.match(preflight.stdout, bare);
	const framed = new RegExp(
		`^ {2}- \\[framed-dive\\]\\(${escapeRegExp(`kb/${FRAMED_DIVE_ID}.md`)}\\) diver=dive-pilot@example\\.invalid - A dive with everything filled in\\.$`,
		"m",
	);
	assert.match(preflight.stdout, framed);

	// Grouping: the unclaimed one is offered, the claimed one is context.
	const available = preflight.stdout.indexOf("Available:");
	const held = preflight.stdout.indexOf("Held:");
	assert.ok(available !== -1 && held !== -1 && available < held, "expected Available above Held");
	assert.ok(
		preflight.stdout.indexOf(BARE_DIVE_ID) > available &&
			preflight.stdout.indexOf(BARE_DIVE_ID) < held,
		"an unclaimed dive belongs under Available",
	);
	assert.ok(preflight.stdout.indexOf("framed-dive") > held, "a claimed dive belongs under Held");

	// Dives outrank the backlog: what the pilot is in the middle of comes first.
	assert.ok(
		preflight.stdout.indexOf("== dives ==") <
			preflight.stdout.indexOf("== open work: current effort backlog =="),
		"the dive section should print above the backlog",
	);
	assert.match(preflight.stdout, /Run `jump` only when the pilot asks for it\./);
});

test("preflight names record.dive --free when there is no dive to pick up", () => {
	const bridge = createBridge(tmp, "no-dives-bridge");
	setIdentity(bridge, "Empty Pilot", "empty-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with no dives failed");
	assert.match(preflight.stdout, /^== dives ==$/m);
	assert.match(preflight.stdout, /^nose: no dive to pick up; run `record\.dive --free`/m);
	assert.doesNotMatch(preflight.stdout, /^Available:$/m);
	assert.doesNotMatch(preflight.stdout, /^Held:$/m);
});

test("preflight fails like whoami when git identity is incomplete", () => {
	const bridge = freshGitBridge("no-identity-bridge");
	runTool("git", ["config", "user.name", "Only Git Name"], bridge);
	// Blank, not unset: the developer's global git config would otherwise supply one.
	runTool("git", ["config", "user.email", ""], bridge);
	writeBridgeConfig(bridge, { backlog: "./backlog" });

	const preflight = run(["preflight"], bridge);
	assert.notEqual(
		preflight.status,
		0,
		"preflight with incomplete git identity unexpectedly succeeded",
	);
	assert.match(preflight.stderr, /missing git config: user\.email/);
	// The hook still installs -- identity is a session-report concern, not a hook-wiring one.
	assert.equal(readFileSync(join(bridge, ".git", "hooks", "pre-push"), "utf8"), MANAGED_HOOK);
});

/**
 * Drift is surfaced here and nowhere else. A gap with a live migration in it
 * blocks -- and blocks at preflight rather than at the first `jump`, which is
 * the earliest point a pilot can be told without having wasted the work of
 * choosing what to work on first.
 */
test("preflight reports level drift, and exits 1 when a migration is in the gap", () => {
	const current = createBridge(tmp, "level-current-bridge");
	setIdentity(current, "Current Pilot", "current-pilot@example.invalid");
	const atLevel = run(["preflight"], current);
	assertOk(atLevel, "preflight on a current bridge failed");
	assert.match(atLevel.stdout, /^nosedive-compatibility-level: 2$/m);

	// One level behind with nothing to run: a note in the report, exit 0.
	const behind = freshGitBridge("level-behind-bridge");
	setIdentity(behind, "Behind Pilot", "behind-pilot@example.invalid");
	write(
		join(behind, ".nosedive", "config.yaml"),
		["compatibility-level: 1", "workspace: ./workspace", "kb: ./kb", "backlog: ./backlog", ""].join(
			"\n",
		),
	);
	const noMigration = run(["preflight"], behind);
	assertOk(noMigration, "preflight refused a bridge with no migration in the gap");
	assert.match(noMigration.stdout, /^nosedive-compatibility-level: 1 \(this nosedive is at 2;/m);
	assert.match(noMigration.stdout, /nothing to migrate/);

	// A live migration in the gap: the level docs, the fix, and exit 1.
	const legacy = freshGitBridge("level-legacy-bridge");
	setIdentity(legacy, "Legacy Pilot", "legacy-pilot@example.invalid");
	write(join(legacy, ".nosediverc"), "workspace: ./workspace\nkb: ./kb\n");
	const blocked = run(["preflight"], legacy);
	assert.notEqual(blocked.status, 0, "preflight on an unmigrated bridge unexpectedly succeeded");
	assert.match(blocked.stderr, /bridge is at compatibility level 0 and this nosedive is at 2/);
	// --headless is asserted, not incidental: bare seed prompts, so an agent
	// following this advice would stall on a question nobody is there to answer.
	assert.match(blocked.stderr, /run `nosedive seed --headless` before working/);
	assert.match(blocked.stderr, /^ {2}level-1 \(migration\):/m);
	assert.match(blocked.stderr, /^ {2}level-2:/m);
	assert.doesNotMatch(blocked.stdout, /== bridge status ==/);

	// And every other contracted command still refuses, naming the same levels.
	const refused = run(["dump-backlog"], legacy);
	assert.notEqual(refused.status, 0, "dump-backlog ran against an unmigrated bridge");
	assert.match(
		refused.stderr,
		/bridge is at compatibility level 0; run `nosedive seed --headless`/,
	);
	assert.match(refused.stderr, /^ {2}level-1:/m);
});
