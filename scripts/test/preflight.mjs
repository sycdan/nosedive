import assert from "node:assert/strict";
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
} from "../test-helpers.mjs";

const tmp = createTmp("preflight");

const MANAGED_HOOK = '#!/bin/sh\n# nosedive-managed\nexec npx nosedive _pre-push.hook "$@"\n';

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
	assert.match(foreignPreflight.stderr, /npx nosedive _pre-push\.hook "\$@" \|\| exit 1/);
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
