import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import {
	assertOk,
	createBridge,
	createTmp,
	escapeRegExp,
	libUrl,
	packageVersion,
	root,
	run,
	gitCommit,
	giveOrigin,
	runTool,
	write,
	writeBridgeConfig,
	cli,
} from "../test-helpers.mjs";

const tmp = createTmp("preflight");
const { nosediveInvocationFor } = await import(libUrl);

const NOSEDIVE_INVOCATION = nosediveInvocationFor(packageVersion, root);
const MANAGED_HOOK = `#!/bin/sh\n# nosedive-managed\nexec ${NOSEDIVE_INVOCATION} _pre-push.hook "$@"\n`;

/** Hook bodies run under `sh`, so every path baked into one is posix. */
const posix = (path) => path.replaceAll("\\", "/");

const managedHooksDir = (bridge) => join(bridge, ".git", "nosedive-hooks");
const managedHook = (bridge) => join(managedHooksDir(bridge), "pre-push");
const originalRecord = (bridge) => join(managedHooksDir(bridge), "original-hooks-dir");

/** Resolved and posix-normalized, so a relative config value still compares. */
function configuredHooksPath(bridge) {
	const value = runTool("git", ["config", "--get", "core.hooksPath"], bridge).stdout.trim();
	return value ? posix(resolve(bridge, value)) : "";
}

/** What the managed hook looks like once it wraps a hook the pilot wrote. */
function chainedHook(originalHookPath) {
	return [
		"#!/bin/sh",
		"# nosedive-managed",
		"refs=$(cat)",
		`original_hook='${posix(originalHookPath)}'`,
		'if [ -x "$original_hook" ]; then',
		`  printf '%s\\n' "$refs" | "$original_hook" "$@" || exit $?`,
		"fi",
		`printf '%s\\n' "$refs" | ${NOSEDIVE_INVOCATION} _pre-push.hook "$@"`,
		"",
	].join("\n");
}

/**
 * Writes a hook the way a pilot would have one: executable. The wrapper only
 * chains an executable file, because git only runs an executable hook, and on
 * a POSIX filesystem a plain `write` leaves the bit off.
 */
function writeExecutableHook(path, body) {
	write(path, body);
	chmodSync(path, 0o755);
}

/** Runs a hook body the way git does: argv from the remote, ref updates on stdin. */
function runHook(hookPath, cwd, refUpdates) {
	return spawnSync("sh", [posix(hookPath), "origin", "git@example.invalid:repo.git"], {
		cwd,
		encoding: "utf8",
		input: refUpdates,
	});
}

function shAvailable() {
	return spawnSync("sh", ["-c", "exit 0"]).error === undefined;
}

test("nosedive invocation pins releases and shell-quotes local CLI paths", () => {
	assert.equal(
		nosediveInvocationFor("2026.8.11-1786460582229", "/unused"),
		"npx -y nosedive@2026.8.11-1786460582229",
	);
	assert.equal(
		nosediveInvocationFor("0.0.0-dev", "/tmp/nosedive's local build"),
		"node '/tmp/nosedive'\\''s local build/dist/cli.js'",
	);
});

function freshGitBridge(name) {
	const bridge = join(tmp, name);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	setIdentity(bridge, "Nosedive Test", "test@nosedive.invalid");
	giveOrigin(tmp, bridge, name);
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
	const installedHook = managedHook(bridge);
	assert.equal(readFileSync(installedHook, "utf8"), MANAGED_HOOK);
	assert.equal(configuredHooksPath(bridge), posix(managedHooksDir(bridge)));
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
	assert.doesNotMatch(preflight.stdout, /nosedive-current-feat/);
	assert.match(preflight.stdout, /^== pilot identification ==$/m);
	assert.match(preflight.stdout, /^nosedive-pilot-name: Install Pilot$/m);
	assert.match(preflight.stdout, /^nosedive-pilot-email: install-pilot@example\.invalid$/m);
	assert.doesNotMatch(preflight.stdout, /^== open work/m);
	assert.match(
		preflight.stderr,
		/no kb directory is configured, so no feats or dives can be listed/,
	);

	const preflightAgain = run(["preflight"], bridge);
	assertOk(preflightAgain, "preflight idempotent refresh failed");
	assert.equal(readFileSync(installedHook, "utf8"), MANAGED_HOOK);
	// The hooks path is already nosedive's, so the re-pin is housekeeping and
	// says nothing. Only the run that moved the hooks path announced itself.
	assert.doesNotMatch(preflightAgain.stdout, /Installed nosedive pre-push hook:/);
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

test("preflight fetches trunk and blocks stale bridge knowledge without rebasing", () => {
	const seed = freshGitBridge("sync-seed");
	// The origin `freshGitBridge` already published `main` to. Cloned below, so
	// the two checkouts diverge the way a pilot's and a teammate's do.
	const remote = join(tmp, "sync-seed-origin.git");
	setIdentity(seed, "Sync Pilot", "sync-pilot@example.invalid");
	writeBridgeConfig(seed, { backlog: "./backlog" });
	write(join(seed, "README.md"), "seed\n");
	runTool("git", ["add", "--", "."], seed);
	gitCommit(seed, "seed bridge");
	runTool("git", ["push"], seed);

	const bridge = join(tmp, "sync-bridge");
	runTool("git", ["clone", remote, bridge], tmp);
	setIdentity(bridge, "Sync Pilot", "sync-pilot@example.invalid");
	runTool("git", ["switch", "-c", "topic"], bridge);
	write(join(bridge, "local.md"), "topic work\n");
	runTool("git", ["add", "--", "local.md"], bridge);
	gitCommit(bridge, "topic work");
	const topicBefore = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	const remoteDiveId = "019fe700-0000-7000-8000-00000000feed";
	write(
		join(seed, "kb", `${remoteDiveId}.md`),
		[
			"---",
			"kind: dive",
			`id: ${remoteDiveId}`,
			"name: remote-dive",
			'gist: "Freshly fetched dive."',
			"---",
			"",
		].join("\n"),
	);
	runTool("git", ["add", "--", `kb/${remoteDiveId}.md`], seed);
	gitCommit(seed, "add remote dive");
	runTool("git", ["push"], seed);

	const preflight = run(["preflight"], bridge);
	assert.notEqual(preflight.status, 0, "stale bridge preflight should exit 1");
	assert.match(
		preflight.stdout,
		/^nosedive-bridge-freshness: HEAD .+ has diverged from origin\/main .+ \(1 ahead, 1 behind\)$/m,
	);
	assert.match(
		preflight.stdout,
		/^nose: fix this\^ first, by rebasing the bridge onto FETCH_HEAD before trusting the dives below$/m,
	);
	assert.doesNotMatch(
		preflight.stdout,
		/remote-dive/,
		"stale local report should not pose as fresh",
	);
	assert.equal(runTool("git", ["branch", "--show-current"], bridge).stdout.trim(), "topic");
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(),
		topicBefore,
		"preflight must not rebase or otherwise move bridge HEAD",
	);
	assert.equal(
		runTool("git", ["rev-parse", "FETCH_HEAD"], bridge).stdout.trim(),
		runTool("git", ["rev-parse", "origin/main"], bridge).stdout.trim(),
		"preflight should leave fetched trunk in FETCH_HEAD for the suggested rebase",
	);
});

test("preflight takes over an unwired foreign hook and chains it", () => {
	const bridge = freshGitBridge("foreign-hook-bridge");
	setIdentity(bridge, "Foreign Hook Pilot", "foreign-hook-pilot@example.invalid");
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	const foreignHook = join(bridge, ".git", "hooks", "pre-push");
	const foreignHookText = "#!/bin/sh\necho user-hook\n";
	write(foreignHook, foreignHookText);

	const foreignPreflight = run(["preflight"], bridge);
	assertOk(foreignPreflight, "preflight with an unwired foreign hook should take it over");
	// The pilot's file is theirs; nosedive runs it, it does not rewrite it.
	assert.equal(readFileSync(foreignHook, "utf8"), foreignHookText);
	assert.equal(readFileSync(managedHook(bridge), "utf8"), chainedHook(foreignHook));
	assert.equal(configuredHooksPath(bridge), posix(managedHooksDir(bridge)));
	assert.equal(readFileSync(originalRecord(bridge), "utf8"), `${posix(dirname(foreignHook))}\n`);
	assert.match(foreignPreflight.stdout, /^== feats and their dives ==$/m);
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
	assert.match(preflight.stdout, /^== feats and their dives ==$/m);
});

test("preflight takes over a core.hooksPath that names no wired hook", () => {
	const bridge = freshGitBridge("hooks-path-bridge");
	setIdentity(bridge, "Hooks Path Pilot", "hooks-path-pilot@example.invalid");
	runTool("git", ["config", "core.hooksPath", ".githooks"], bridge);
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	const pilotHook = join(bridge, ".githooks", "pre-push");
	const pilotHookText = "#!/bin/sh\necho pilot-gate\n";
	write(pilotHook, pilotHookText);

	const hooksPathPreflight = run(["preflight"], bridge);
	assertOk(hooksPathPreflight, "preflight should take over an unwired core.hooksPath");
	assert.equal(readFileSync(pilotHook, "utf8"), pilotHookText);
	assert.equal(readFileSync(managedHook(bridge), "utf8"), chainedHook(pilotHook));
	assert.equal(configuredHooksPath(bridge), posix(managedHooksDir(bridge)));
	// Taking a hooks path over must not leave a second pre-push in .git/hooks:
	// git reads exactly one hooks directory, and the loser rots unwatched.
	assert.equal(existsSync(join(bridge, ".git", "hooks", "pre-push")), false);
	assert.match(hooksPathPreflight.stdout, /^Installed nosedive pre-push hook:/m);
	assert.match(hooksPathPreflight.stdout, /^== feats and their dives ==$/m);
});

test("preflight reconciles the same hooks path again without re-chaining itself", () => {
	const bridge = freshGitBridge("hooks-path-idempotent-bridge");
	setIdentity(bridge, "Idempotent Pilot", "idempotent-pilot@example.invalid");
	runTool("git", ["config", "core.hooksPath", ".githooks"], bridge);
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	const pilotHook = join(bridge, ".githooks", "pre-push");
	write(pilotHook, "#!/bin/sh\necho pilot-gate\n");

	assertOk(run(["preflight"], bridge), "first preflight failed");
	const afterFirst = readFileSync(managedHook(bridge), "utf8");
	assertOk(run(["preflight"], bridge), "second preflight failed");

	// The managed hook is now what core.hooksPath points at, so a second run
	// must chain the pilot's recorded hook again -- never the managed hook it
	// wrote last time, which would recurse.
	assert.equal(readFileSync(managedHook(bridge), "utf8"), afterFirst);
	assert.equal(afterFirst, chainedHook(pilotHook));
});

test("preflight proxies the pilot's other hooks when it takes the hooks path over", () => {
	const bridge = freshGitBridge("hooks-path-proxy-bridge");
	setIdentity(bridge, "Proxy Pilot", "proxy-pilot@example.invalid");
	runTool("git", ["config", "core.hooksPath", ".githooks"], bridge);
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	write(join(bridge, ".githooks", "pre-push"), "#!/bin/sh\necho pilot-gate\n");
	const pilotCommitMsg = join(bridge, ".githooks", "commit-msg");
	write(pilotCommitMsg, "#!/bin/sh\necho pilot-commit-msg\n");

	assertOk(run(["preflight"], bridge), "preflight failed");

	// Claiming core.hooksPath moves every hook name, not just pre-push, so the
	// ones nosedive has no opinion about have to keep firing.
	assert.equal(
		readFileSync(join(managedHooksDir(bridge), "commit-msg"), "utf8"),
		`#!/bin/sh\nexec '${posix(pilotCommitMsg)}' "$@"\n`,
	);
	assert.equal(existsSync(join(managedHooksDir(bridge), "pre-commit")), false);
});

test("preflight re-pins a stale managed hook rather than leaving it to rot", () => {
	const bridge = freshGitBridge("stale-managed-bridge");
	setIdentity(bridge, "Stale Pilot", "stale-pilot@example.invalid");
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	const stale = join(bridge, ".git", "hooks", "pre-push");
	// What a managed hook written by an older nosedive looks like today: a
	// command name that no longer exists, resolved off a moving dist-tag.
	write(stale, '#!/bin/sh\n# nosedive-managed\nexec npx nosedive pre-push.hook "$@"\n');

	assertOk(run(["preflight"], bridge), "preflight failed");
	// Re-pinned into the one directory nosedive maintains. A managed hook is
	// never chained to, so nothing carries the dead command name forward.
	assert.equal(readFileSync(managedHook(bridge), "utf8"), MANAGED_HOOK);
	assert.equal(existsSync(stale), false);
});

test("preflight drops a managed hook that a wired hooks path has shadowed", () => {
	const bridge = freshGitBridge("shadowed-managed-bridge");
	setIdentity(bridge, "Shadowed Pilot", "shadowed-pilot@example.invalid");
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	const shadowed = join(bridge, ".git", "hooks", "pre-push");
	write(shadowed, MANAGED_HOOK);
	runTool("git", ["config", "core.hooksPath", ".githooks"], bridge);
	write(
		join(bridge, ".githooks", "pre-push"),
		'#!/bin/sh\nexec npx -y nosedive@2026.1.1-0 _pre-push.hook "$@"\n',
	);

	assertOk(run(["preflight"], bridge), "preflight failed");
	// git reads one hooks directory. A managed hook outside it cannot run and
	// nothing refreshes it, which is exactly how one rotted to a dead command
	// name while preflight kept reporting the shadowing file as wired.
	assert.equal(existsSync(shadowed), false);
	assert.equal(configuredHooksPath(bridge), posix(join(bridge, ".githooks")));
});

test(
	"the reconciled hook runs the pilot's hook first, on the same ref updates",
	{ skip: !shAvailable() },
	() => {
		const bridge = freshGitBridge("chained-run-bridge");
		setIdentity(bridge, "Chained Pilot", "chained-pilot@example.invalid");
		runTool("git", ["config", "core.hooksPath", ".githooks"], bridge);
		writeBridgeConfig(bridge, { backlog: "./backlog" });
		const seen = posix(join(bridge, "pilot-saw.txt"));
		writeExecutableHook(join(bridge, ".githooks", "pre-push"), `#!/bin/sh\ncat > '${seen}'\n`);

		assertOk(run(["preflight"], bridge), "preflight failed");

		// A deleted ref: nosedive's own gate reads it and has nothing to walk, so
		// what this asserts is the wrapper, not the gate.
		const zero = "0".repeat(40);
		const refs = `(delete) ${zero} refs/heads/gone ${zero}\n`;
		const hookRun = runHook(managedHook(bridge), bridge, refs);
		assert.equal(hookRun.status, 0, `chained hook failed:\n${hookRun.stderr}`);
		// pre-push reads its ref updates from stdin, and a stream is consumed once.
		// Both hooks have to see the same list, so the wrapper replays it.
		assert.equal(readFileSync(seen, "utf8").trim(), refs.trim());
	},
);

test(
	"a pilot hook that rejects the push stops nosedive's gate from running",
	{ skip: !shAvailable() },
	() => {
		const bridge = freshGitBridge("chained-reject-bridge");
		setIdentity(bridge, "Rejecting Pilot", "rejecting-pilot@example.invalid");
		runTool("git", ["config", "core.hooksPath", ".githooks"], bridge);
		writeBridgeConfig(bridge, { backlog: "./backlog" });
		writeExecutableHook(
			join(bridge, ".githooks", "pre-push"),
			"#!/bin/sh\ncat > /dev/null\necho nope >&2\nexit 3\n",
		);

		assertOk(run(["preflight"], bridge), "preflight failed");

		const hookRun = runHook(managedHook(bridge), bridge, "refs/heads/main a refs/heads/main b\n");
		assert.equal(hookRun.status, 3, "the pilot's exit status is the push's answer");
		assert.match(hookRun.stderr, /nope/);
	},
);

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

test("preflight stays silent for seeded instructions with the current digest", () => {
	const bridge = createBridge(tmp, "instruction-silent-bridge");
	setIdentity(bridge, "Silent Pilot", "silent-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight failed");
	assert.doesNotMatch(preflight.stdout, /^nose: .*instructions/m);
});

test("preflight reports instruction drift without rewriting the file", () => {
	const bridge = createBridge(tmp, "instruction-drift-bridge");
	setIdentity(bridge, "Drift Pilot", "drift-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const instructionsPath = join(bridge, "AGENTS.md");
	const before = readFileSync(instructionsPath, "utf8");
	const altered = before.replace(/surface=([0-9a-f]{8})/, (match, digest) => {
		const char = digest[7] === "0" ? "1" : "0";
		return `surface=${digest.slice(0, 7)}${char}`;
	});
	write(instructionsPath, altered);

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight failed");
	assert.match(preflight.stdout, /^nose: AGENTS\.md.*Run: nosedive seed$/m);
	assert.equal(readFileSync(instructionsPath, "utf8"), altered);
	assert.notEqual(readFileSync(instructionsPath, "utf8"), before);
});

test("preflight reports bridge status, pilot identity and the active dive, and no backlog", () => {
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

	assertOk(run(["update-backlog", "--inject", effortId], bridge), "update-backlog failed");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight report failed");
	assert.doesNotMatch(preflight.stdout, /nosedive-current-effort|current effort backlog/);

	const bridgeIdx = preflight.stdout.indexOf("== bridge status ==");
	const pilotIdx = preflight.stdout.indexOf("== pilot identification ==");
	const divesIdx = preflight.stdout.indexOf("== feats and their dives ==");
	assert.ok(
		bridgeIdx !== -1 && bridgeIdx < pilotIdx && pilotIdx < divesIdx,
		`sections missing or out of order:\n${preflight.stdout}`,
	);
	// The backlog is a document to ask for, not one every session pays for.
	assert.doesNotMatch(preflight.stdout, /^== open work/m);
	assert.match(preflight.stdout, /start with `nosedive jump <doc-path>`/);

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
		new RegExp(`^nosedive-current-feat: ${escapeRegExp(effortId)}$`, "m"),
	);
	assert.match(preflight.stdout, /^nosedive-pilot-name: Report Pilot$/m);
	assert.match(preflight.stdout, /^nosedive-pilot-email: report-pilot@example\.invalid$/m);
	// The feat's gist came out of the backlog body and is gone with it. A feat
	// header names the feat and links it; anyone who wants the gist reads it.
	assert.doesNotMatch(preflight.stdout, /Report the dive\./);
});

const TOP_FEAT_ID = "019fe500-0000-7000-8000-000000000001";
const CHILD_FEAT_ID = "019fe500-0000-7000-8000-000000000002";
const OFF_BACKLOG_FEAT_ID = "019fe500-0000-7000-8000-000000000003";
const PLANNED_DIVE_ID = "019fe500-0000-7000-8000-00000000dead";
const PENDING_DIVE_ID = "019fe500-0000-7000-8000-00000000beef";
const WORKING_PACKED_DIVE_ID = "019fe500-0000-7000-8000-00000000cafe";
const JUMPED_PACKED_DIVE_ID = "019fe500-0000-7000-8000-00000000fade";
const PACKED_DIVE_ID = "019fe500-0000-7000-8000-00000000f00e";
const REVIEWING_DIVE_ID = "019fe500-0000-7000-8000-00000000fee1";
const HELD_WORKING_DIVE_ID = "019fe500-0000-7000-8000-00000000feed";
const HELD_PENDING_DIVE_ID = "019fe500-0000-7000-8000-00000000c0de";
const LANDED_DIVE_ID = "019fe500-0000-7000-8000-00000000abba";
const BAILED_DIVE_ID = "019fe500-0000-7000-8000-00000000ba11";
const UNLINKED_DIVE_ID = "019fe500-0000-7000-8000-00000000babe";
const OFF_BACKLOG_DIVE_ID = "019fe500-0000-7000-8000-00000000f00d";
const HELD_HEADING = "Held by other pilots:";

function backlogId(bridge) {
	const match = /^backlog: (\S+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	);
	assert.ok(match, "seed should configure a backlog memo");
	return match[1];
}

function writeBacklogMemo(bridge, id, links) {
	write(
		join(bridge, "kb", `${id}.md`),
		[
			"---",
			"kind: memo",
			`id: ${id}`,
			"name: backlog.fixture",
			'gist: "Backlog fixture."',
			"links:",
			...links,
			"---",
			"",
			"# Backlog",
			"",
		].join("\n"),
	);
}

function writeFeatDoc(bridge, id, name, links = []) {
	write(
		join(bridge, "kb", `${id}.md`),
		[
			"---",
			"kind: feat",
			`id: ${id}`,
			`name: ${name}`,
			`gist: "Fixture ${name}."`,
			...(links.length > 0 ? ["links:", ...links] : []),
			"---",
			"",
			`# ${name}`,
			"",
		].join("\n"),
	);
}

function link(id, rel) {
	return [`  - kb/${id}.md:`, `      rel: ${rel}`];
}

function writeDiveDoc(bridge, id, name, { diver = null, effort = TOP_FEAT_ID, log = false } = {}) {
	write(
		join(bridge, "kb", `${id}.md`),
		[
			"---",
			"kind: dive",
			`id: ${id}`,
			`name: ${name}`,
			`gist: "Fixture ${name}."`,
			"scopes:",
			"  - 019f514e-d8d5-7bc1-bf3f-d8e5092c6596:",
			"      mode: rw",
			"meta:",
			`  effort: ${effort}`,
			`  diver: ${diver ?? "null"}`,
			"---",
			"",
			"# Dive Record",
			"",
			"## Brief",
			"",
			"Do the thing.",
			...(log
				? [
						"",
						"## 2026-08-09T05:02:49.670Z",
						"",
						"- repo=nosedive path=workspace/nosedive mode=rw ref=deadbee",
					]
				: []),
			"",
		].join("\n"),
	);
}

test("preflight lists only backlog-reachable planned/pending and packed dives", () => {
	const bridge = createBridge(tmp, "dives-bridge");
	setIdentity(bridge, "Dive Pilot", "dive-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const backlog = backlogId(bridge);

	writeBacklogMemo(bridge, backlog, link(TOP_FEAT_ID, "release-effort"));
	writeFeatDoc(bridge, TOP_FEAT_ID, "top-fixture", [
		...link(CHILD_FEAT_ID, "slice-effort"),
		...link(PLANNED_DIVE_ID, "planned.dive"),
		...link(HELD_WORKING_DIVE_ID, "working.dive"),
		...link(LANDED_DIVE_ID, "landed.dive"),
		...link(BAILED_DIVE_ID, "bailed.dive"),
	]);
	writeFeatDoc(bridge, CHILD_FEAT_ID, "child-fixture", [
		...link(PENDING_DIVE_ID, "pending.dive"),
		...link(WORKING_PACKED_DIVE_ID, "working.dive"),
		...link(JUMPED_PACKED_DIVE_ID, "jumped.dive"),
		...link(PACKED_DIVE_ID, "packed.dive"),
		...link(REVIEWING_DIVE_ID, "reviewing.dive"),
		// Bare, unsuffixed: what `record.dive` still writes, so the legacy rel has
		// to keep reading as the same edge.
		...link(HELD_PENDING_DIVE_ID, "pending"),
	]);
	writeFeatDoc(bridge, OFF_BACKLOG_FEAT_ID, "off-backlog-fixture", [
		...link(OFF_BACKLOG_DIVE_ID, "pending"),
	]);

	writeDiveDoc(bridge, PLANNED_DIVE_ID, "planned-dive");
	writeDiveDoc(bridge, PENDING_DIVE_ID, "pending-dive");
	writeDiveDoc(bridge, WORKING_PACKED_DIVE_ID, "working-packed-dive", { log: true });
	writeDiveDoc(bridge, JUMPED_PACKED_DIVE_ID, "jumped-packed-dive", { log: true });
	writeDiveDoc(bridge, PACKED_DIVE_ID, "packed-dive", { log: true });
	writeDiveDoc(bridge, REVIEWING_DIVE_ID, "reviewing-dive", {
		effort: CHILD_FEAT_ID,
		log: true,
	});
	writeDiveDoc(bridge, HELD_WORKING_DIVE_ID, "held-working-dive", {
		diver: "dive-pilot@example.invalid",
		log: true,
	});
	writeDiveDoc(bridge, HELD_PENDING_DIVE_ID, "held-pending-dive", {
		diver: "other-pilot@example.invalid",
		effort: CHILD_FEAT_ID,
	});
	writeDiveDoc(bridge, LANDED_DIVE_ID, "landed-dive");
	writeDiveDoc(bridge, BAILED_DIVE_ID, "bailed-dive");
	writeDiveDoc(bridge, UNLINKED_DIVE_ID, "unlinked-dive");
	writeDiveDoc(bridge, OFF_BACKLOG_DIVE_ID, "off-backlog-dive", {
		effort: OFF_BACKLOG_FEAT_ID,
	});

	runTool("git", ["add", "--", "kb", ".nosedive", "AGENTS.md"], bridge);
	gitCommit(bridge, "commit backlog dive graph");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with dives failed");
	assert.match(preflight.stdout, /^== feats and their dives ==$/m);

	// The path leads the line because the path is the argument `jump` takes.
	// The name is not on the line at all, so nothing else can be taken for it.
	for (const [id, name] of [
		[PLANNED_DIVE_ID, "planned-dive"],
		[PENDING_DIVE_ID, "pending-dive"],
		[WORKING_PACKED_DIVE_ID, "working-packed-dive"],
		[JUMPED_PACKED_DIVE_ID, "jumped-packed-dive"],
		[PACKED_DIVE_ID, "packed-dive"],
		[REVIEWING_DIVE_ID, "reviewing-dive"],
	]) {
		assert.match(
			preflight.stdout,
			new RegExp(`^- ${escapeRegExp(`kb/${id}.md`)}: Fixture ${name}\\. -- needs=diver`, "m"),
		);
	}
	assert.doesNotMatch(preflight.stdout, /rel=/, "a rel is not something to jump by");

	// Each dive sits under the feat whose links reached it, and the header
	// carries the feat's path but not its gist.
	for (const [feat, id] of [
		["Top Fixture", TOP_FEAT_ID],
		["Child Fixture", CHILD_FEAT_ID],
	]) {
		assert.match(
			preflight.stdout,
			new RegExp(`^## \\[${feat}\\]\\(${escapeRegExp(`kb/${id}.md`)}\\)$`, "m"),
		);
	}
	assert.doesNotMatch(preflight.stdout, /Fixture top-fixture\.|Fixture child-fixture\./);

	const topHeader = preflight.stdout.indexOf("[Top Fixture]");
	const childHeader = preflight.stdout.indexOf("[Child Fixture]");
	const plannedDive = preflight.stdout.indexOf("planned-dive");
	const pendingDive = preflight.stdout.indexOf("pending-dive");
	assert.ok(
		topHeader < plannedDive && plannedDive < childHeader && childHeader < pendingDive,
		`dives are not grouped under their feats:\n${preflight.stdout}`,
	);

	// Available dives get no heading of their own: they are the listing, and the
	// only section under them is the one nobody here can take.
	const held = preflight.stdout.indexOf(HELD_HEADING);
	assert.notEqual(held, -1, "expected a held section");
	assert.ok(
		preflight.stdout.indexOf("working-packed-dive") < held,
		"a legacy working dive is available",
	);
	assert.ok(preflight.stdout.indexOf("packed-dive") < held, "a packed dive is available");
	// `reviewing` is a working rel that neither of the old admit-lists named, so
	// a reviewing dive used to be invisible. Nothing bailed or landed it, so it
	// is still work someone can pick up.
	assert.ok(preflight.stdout.indexOf("reviewing-dive") < held, "a reviewing dive is available");
	// A claimed dive is held only when somebody else holds it: the running
	// pilot's own claimed dive is the one they came back for, so it stays on
	// offer and its diver is printed on the line.
	assert.match(
		preflight.stdout,
		new RegExp(
			`^- ${escapeRegExp(`kb/${HELD_PENDING_DIVE_ID}.md`)}: Fixture held-pending-dive\\. -- diver=other-pilot@example\\.invalid`,
			"m",
		),
	);
	assert.ok(
		preflight.stdout.indexOf("held-pending-dive") > held,
		"a pending dive another pilot holds is held",
	);
	assert.match(
		preflight.stdout,
		new RegExp(
			`^- ${escapeRegExp(`kb/${HELD_WORKING_DIVE_ID}.md`)}: Fixture held-working-dive\\. -- diver=dive-pilot@example\\.invalid`,
			"m",
		),
	);
	assert.ok(
		preflight.stdout.indexOf("held-working-dive") < held,
		"the running pilot's own working dive is available",
	);
	for (const hidden of ["landed-dive", "bailed-dive", "unlinked-dive", "off-backlog-dive"]) {
		assert.doesNotMatch(preflight.stdout, new RegExp(hidden));
	}

	// The backlog memo is walked for these dives but never printed: the feat
	// headers are what the pilot needs, and the rest is `dump-backlog`'s job.
	assert.doesNotMatch(preflight.stdout, /^== open work/m);
	assert.doesNotMatch(preflight.stdout, /Backlog fixture\./);
	// The listing prints paths, so the guidance has to name the same thing: an
	// agent told one and shown the other is back to guessing.
	assert.match(preflight.stdout, /start with `nosedive jump <doc-path>`/);
});

test("preflight names record.dive --free when there is no dive to pick up", () => {
	const bridge = createBridge(tmp, "no-dives-bridge");
	setIdentity(bridge, "Empty Pilot", "empty-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with no dives failed");
	assert.match(preflight.stdout, /^== feats and their dives ==$/m);
	assert.match(preflight.stdout, /^nose: no dive to pick up; run `record\.dive --free`/m);
	assert.doesNotMatch(preflight.stdout, /^## /m);
	assert.doesNotMatch(preflight.stdout, new RegExp(`^${HELD_HEADING}$`, "m"));
});

/**
 * A backlog reaching one feat reaching one dive. Every eligibility question is
 * about one dive and one pilot, so the graph stays at the smallest shape that
 * can answer one and the assertion is the only interesting part of the test.
 */
function bridgeWithOneDive(name, email, { rel = "packed.dive", diver } = {}) {
	const bridge = createBridge(tmp, name);
	setIdentity(bridge, "Solo Pilot", email);
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	writeBacklogMemo(bridge, backlogId(bridge), link(TOP_FEAT_ID, "release-effort"));
	writeFeatDoc(bridge, TOP_FEAT_ID, "solo-fixture", [...link(PACKED_DIVE_ID, rel)]);
	writeDiveDoc(bridge, PACKED_DIVE_ID, "solo-dive", { diver, log: true });
	runTool("git", ["add", "--", "kb", ".nosedive", "AGENTS.md"], bridge);
	gitCommit(bridge, "commit solo dive graph");
	return bridge;
}

/**
 * The section a named dive was printed under, or undefined when it was not.
 * A dive line carries its path and its gist and not its name, so the fixture
 * gist is what identifies the dive in the output.
 */
function diveSection(stdout, name) {
	const dive = stdout.indexOf(`Fixture ${name}.`);
	if (dive === -1) return undefined;
	const held = stdout.indexOf(HELD_HEADING);
	return held !== -1 && dive > held ? "Held" : "Available";
}

test("preflight lists a packed dive the running pilot holds under Available", () => {
	const bridge = bridgeWithOneDive("own-packed-bridge", "solo-pilot@example.invalid", {
		diver: "solo-pilot@example.invalid",
	});

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with an own-held packed dive failed");
	assert.equal(diveSection(preflight.stdout, "solo-dive"), "Available");
	assert.match(
		preflight.stdout,
		/- kb\/.+\.md: Fixture solo-dive\. -- diver=solo-pilot@example\.invalid/,
	);
});

test("preflight holds a packed dive another pilot claimed", () => {
	const bridge = bridgeWithOneDive("other-packed-bridge", "solo-pilot@example.invalid", {
		diver: "other-pilot@example.invalid",
	});

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with an other-held packed dive failed");
	assert.equal(diveSection(preflight.stdout, "solo-dive"), "Held");
});

test("preflight hides a bailed or landed dive whose doc is still kind: dive", () => {
	const bridge = createBridge(tmp, "finished-dive-bridge");
	setIdentity(bridge, "Finished Pilot", "finished-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	writeBacklogMemo(bridge, backlogId(bridge), link(TOP_FEAT_ID, "release-effort"));
	writeFeatDoc(bridge, TOP_FEAT_ID, "finished-fixture", [
		...link(PENDING_DIVE_ID, "pending.dive"),
		...link(LANDED_DIVE_ID, "landed.dive"),
		...link(BAILED_DIVE_ID, "bailed.dive"),
	]);
	writeDiveDoc(bridge, PENDING_DIVE_ID, "live-dive");
	writeDiveDoc(bridge, LANDED_DIVE_ID, "landed-dive");
	writeDiveDoc(bridge, BAILED_DIVE_ID, "bailed-dive");

	runTool("git", ["add", "--", "kb", ".nosedive", "AGENTS.md"], bridge);
	gitCommit(bridge, "commit finished dive graph");

	// The rel is the whole reason these two are gone: `land` and `bail` rewrite
	// the doc's kind, and these fixtures deliberately have not, so a listing
	// that read only the doc would still print them.
	for (const id of [LANDED_DIVE_ID, BAILED_DIVE_ID]) {
		assert.match(readFileSync(join(bridge, "kb", `${id}.md`), "utf8"), /^kind: dive$/m);
	}

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with finished dives failed");
	assert.equal(diveSection(preflight.stdout, "live-dive"), "Available");
	assert.doesNotMatch(preflight.stdout, /landed-dive/);
	assert.doesNotMatch(preflight.stdout, /bailed-dive/);
});

test("preflight never reaches a dive behind an edge that is not a feat rel", () => {
	const bridge = createBridge(tmp, "off-rel-bridge");
	setIdentity(bridge, "Off Rel Pilot", "off-rel-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	// `note` is a provenance edge, not a backlog edge. The feat behind it is a
	// real feat with a real dive, so only the rel keeps the dive out.
	writeBacklogMemo(bridge, backlogId(bridge), [
		...link(TOP_FEAT_ID, "note"),
		...link(CHILD_FEAT_ID, "release-effort"),
	]);
	writeFeatDoc(bridge, TOP_FEAT_ID, "noted-fixture", [...link(PLANNED_DIVE_ID, "planned.dive")]);
	writeFeatDoc(bridge, CHILD_FEAT_ID, "walked-fixture", [...link(PENDING_DIVE_ID, "pending.dive")]);
	writeDiveDoc(bridge, PLANNED_DIVE_ID, "unreached-dive");
	writeDiveDoc(bridge, PENDING_DIVE_ID, "walked-dive", { effort: CHILD_FEAT_ID });

	runTool("git", ["add", "--", "kb", ".nosedive", "AGENTS.md"], bridge);
	gitCommit(bridge, "commit off-rel dive graph");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with an off-rel feat failed");
	assert.equal(diveSection(preflight.stdout, "walked-dive"), "Available");
	assert.doesNotMatch(preflight.stdout, /unreached-dive/);
});

test("preflight does not list a dive linked straight off the backlog memo", () => {
	const bridge = createBridge(tmp, "deck-linked-bridge");
	setIdentity(bridge, "Deck Pilot", "deck-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	// Only a dive a feat owns is selectable. A free dive stays possible, and
	// stays deliberately hard to pick up until it names a feat.
	writeBacklogMemo(bridge, backlogId(bridge), [
		...link(TOP_FEAT_ID, "release-effort"),
		...link(PLANNED_DIVE_ID, "planned.dive"),
	]);
	writeFeatDoc(bridge, TOP_FEAT_ID, "owner-fixture", [...link(PENDING_DIVE_ID, "pending.dive")]);
	writeDiveDoc(bridge, PLANNED_DIVE_ID, "deck-linked-dive");
	writeDiveDoc(bridge, PENDING_DIVE_ID, "feat-linked-dive");

	runTool("git", ["add", "--", "kb", ".nosedive", "AGENTS.md"], bridge);
	gitCommit(bridge, "commit deck-linked dive graph");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with a deck-linked dive failed");
	assert.equal(diveSection(preflight.stdout, "feat-linked-dive"), "Available");
	assert.doesNotMatch(preflight.stdout, /deck-linked-dive/);
	assert.doesNotMatch(preflight.stdout, /Free dives/);
});

/**
 * The dive list is only as good as the backlog it walks from, so a bridge whose
 * backlog memo cannot be resolved has no reachable dives -- including dives that
 * a kb-wide scan would have found. The empty list is not silent: the backlog
 * section names the missing memo on stderr.
 */
test("preflight lists no dives when the backlog memo cannot be resolved", () => {
	const bridge = createBridge(tmp, "no-backlog-bridge");
	setIdentity(bridge, "Lost Pilot", "lost-pilot@example.invalid");
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	const missing = "019fe500-0000-7000-8000-0000000000ff";
	writeBridgeConfig(bridge, { backlog: missing });
	writeFeatDoc(bridge, TOP_FEAT_ID, "orphan-fixture", [...link(PENDING_DIVE_ID, "pending.dive")]);
	writeDiveDoc(bridge, PENDING_DIVE_ID, "unreachable-dive");

	const preflight = run(["preflight"], bridge);
	assertOk(preflight, "preflight with an unresolvable backlog failed");
	assert.match(preflight.stdout, /^nose: no dive to pick up; run `record\.dive --free`/m);
	assert.doesNotMatch(preflight.stdout, /unreachable-dive/);
	assert.match(preflight.stderr, new RegExp(`bridge backlog memo not found: ${missing}`));

	// Same rule for a backlog id that could never resolve: an empty list has to
	// say it is empty because the memo is unreadable, not because there is no
	// work. Nothing else prints the backlog now, so nothing else would say it.
	writeBridgeConfig(bridge, { backlog: "./backlog" });
	const unshaped = run(["preflight"], bridge);
	assertOk(unshaped, "preflight with a non-UUID backlog failed");
	assert.match(unshaped.stdout, /^nose: no dive to pick up; run `record\.dive --free`/m);
	assert.match(
		unshaped.stderr,
		/listing dives requires a UUID-shaped backlog memo id: \.\/backlog/,
	);
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
	assert.equal(readFileSync(managedHook(bridge), "utf8"), MANAGED_HOOK);
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

	// One level behind with a live migration in the gap: the report blocks
	// before printing backlog state.
	const behind = freshGitBridge("level-behind-bridge");
	setIdentity(behind, "Behind Pilot", "behind-pilot@example.invalid");
	write(
		join(behind, ".nosedive", "config.yaml"),
		["compatibility-level: 1", "workspace: ./workspace", "kb: ./kb", "backlog: ./backlog", ""].join(
			"\n",
		),
	);
	const blockedL1 = run(["preflight"], behind);
	assert.notEqual(blockedL1.status, 0, "preflight on an L1 bridge unexpectedly succeeded");
	assert.match(blockedL1.stderr, /bridge is at compatibility level 1 and this nosedive is at 2/);
	assert.match(blockedL1.stderr, /run `nosedive seed --headless` before working/);
	assert.match(blockedL1.stderr, /^ {2}level-2 \(migration\):/m);
	assert.doesNotMatch(blockedL1.stdout, /== bridge status ==/);

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
	assert.match(blocked.stderr, /^ {2}level-2 \(migration\):/m);
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
