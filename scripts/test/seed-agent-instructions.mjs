import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createTmp, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("seed-agent-instructions");

const BEGIN = "<!-- BEGIN nosedive managed instructions -->";
const END = "<!-- END nosedive managed instructions -->";

function newBridge(name) {
	const bridgeDir = join(tmp, name);
	mkdirSync(bridgeDir, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridgeDir);
	runTool("git", ["config", "user.name", "Instructions Person"], bridgeDir);
	runTool("git", ["config", "user.email", "instructions@example.invalid"], bridgeDir);
	return bridgeDir;
}

function assertManagedBlock(text, label) {
	assert.match(text, new RegExp(`^${BEGIN}$`, "m"), `${label} is missing the begin marker`);
	assert.match(text, new RegExp(`^${END}$`, "m"), `${label} is missing the end marker`);
	// The invocation names the nosedive that wrote the block: a published
	// install pins its version, this test's local checkout points at its cli.
	assert.match(text, /^- When you run `nosedive <command>`, use `.+ <command>`\.$/m);
	assert.match(
		text,
		/^- If any `nosedive <command>` output line starts with `nose:`, it is a direct call to attention; handle it before tackling other work\.$/m,
	);
	assert.match(
		text,
		/^- Call `nosedive preflight` before your first reply to the pilot in a session, but only if `nosedive-pilot-name` is unknown\.$/m,
	);
	assert.match(text, /^These commands are available to you:$/m);
	assert.match(text, /^Usage: nosedive <command>$/m);
	// The agent surface is a block per command, not the pilot-facing table, so a
	// `Use when:` trigger cannot be read against the wrong command.
	assert.match(text, /^ {2}seed$/m);
	assert.match(text, /^ {4}Create, migrate, or edit bridge config/m);
	assert.match(
		text,
		/^ {4}Use when: only on explicit pilot request, or in response to a nosedive/m,
	);
	const commands = [...text.matchAll(/^ {2}(\S+)\n {4}.+\n {4}(.+)$/gm)];
	assert.notEqual(commands.length, 0, `${label} lists no commands`);
	for (const [, command, useWhen] of commands) {
		assert.match(useWhen, /^Use when: \S/, `${label} command ${command} has no Use when line`);
	}
}

test("seed-agent-instructions", () => {
	// Nothing to manage and nothing named: seed creates AGENTS.md for the new bridge.
	const bareBridge = newBridge("bare-bridge");
	const bare = run(["seed", "--headless"], bareBridge, "");
	assertOk(bare, "seed without any instructions file failed");
	assert.match(bare.stdout, /Wrote AGENTS\.md/);
	assert.equal(existsSync(join(bareBridge, ".nosedive", "config.yaml")), true);
	assert.match(
		readFileSync(join(bareBridge, "AGENTS.md"), "utf8"),
		/<!-- BEGIN nosedive managed instructions -->/,
	);
	assert.equal(existsSync(join(bareBridge, ".nosedive", ".gitignore")), true);
	const backlogMemos = readdirSync(join(bareBridge, "kb")).filter((entry) => entry.endsWith(".md"));
	assert.equal(backlogMemos.length, 1, "fresh seed should mint exactly one backlog memo");
	assert.match(readFileSync(join(bareBridge, "kb", backlogMemos[0]), "utf8"), /^# Backlog$/m);
	assert.equal(existsSync(join(bareBridge, "CLAUDE.md")), false);
	assert.equal(existsSync(join(bareBridge, "GEMINI.md")), false);
	assert.equal(existsSync(join(bareBridge, ".github", "copilot-instructions.md")), false);

	// A named file that does not exist is created whole and no AGENTS.md is created.
	const createdBridge = newBridge("created-bridge");
	const created = run(["seed", "--headless", "--file", "NOTES.md"], createdBridge, "");
	assertOk(created, "seed with a missing --file failed");
	assert.match(created.stdout, /Wrote NOTES\.md/);
	assert.doesNotMatch(created.stdout, /Wrote AGENTS\.md/);
	const createdText = readFileSync(join(createdBridge, "NOTES.md"), "utf8");
	assert.equal(createdText.startsWith("# Agent Instructions\n\n"), true);
	assertManagedBlock(createdText, "NOTES.md");
	assert.equal(existsSync(join(createdBridge, "AGENTS.md")), false);

	// Autodetected, and only the span between the markers is rewritten.
	const detectedBridge = newBridge("detected-bridge");
	const preamble = "# Agent Instructions\n\nPilot-owned preamble.\n\n";
	const trailer = "\n\nPilot-owned trailer.\n";
	write(join(detectedBridge, "AGENTS.md"), `${preamble}${BEGIN}\nstale junk\n${END}${trailer}`);
	const detected = run(["seed", "--headless"], detectedBridge, "");
	assertOk(detected, "seed with an autodetected instructions file failed");
	assert.match(detected.stdout, /Wrote AGENTS\.md/);
	const detectedText = readFileSync(join(detectedBridge, "AGENTS.md"), "utf8");
	assert.equal(detectedText.startsWith(preamble), true, "content before the block changed");
	assert.equal(detectedText.endsWith(trailer), true, "content after the block changed");
	assert.doesNotMatch(detectedText, /stale junk/);
	assertManagedBlock(detectedText, "AGENTS.md");

	// One target has markers and one does not: the marker-less file is skipped
	// with a warning naming the pair to add, and seed still succeeds.
	const mixedBridge = newBridge("mixed-bridge");
	write(join(mixedBridge, "AGENTS.md"), `${BEGIN}\n${END}\n`);
	const untouched = "# Claude\n\nNo markers here.\n";
	write(join(mixedBridge, "CLAUDE.md"), untouched);
	const mixed = run(["seed", "--headless"], mixedBridge, "");
	assertOk(mixed, "seed with one seedable instructions file failed");
	assert.match(mixed.stdout, /Wrote AGENTS\.md/);
	assert.doesNotMatch(mixed.stdout, /Wrote CLAUDE\.md/);
	assert.match(mixed.stderr, /skipped CLAUDE\.md: no nosedive managed instructions block/);
	assert.match(mixed.stderr, new RegExp(`^ {2}${BEGIN}$`, "m"));
	assert.match(mixed.stderr, new RegExp(`^ {2}${END}$`, "m"));
	assert.equal(readFileSync(join(mixedBridge, "CLAUDE.md"), "utf8"), untouched);
	assertManagedBlock(readFileSync(join(mixedBridge, "AGENTS.md"), "utf8"), "AGENTS.md");

	// No target could be seeded at all: fatal, and nothing is written.
	const unmarkedBridge = newBridge("unmarked-bridge");
	write(join(unmarkedBridge, "AGENTS.md"), untouched);
	const unmarked = run(["seed", "--headless"], unmarkedBridge, "");
	assert.notEqual(unmarked.status, 0, "seed with no seedable file unexpectedly succeeded");
	assert.match(unmarked.stderr, /no agent instructions file could be seeded: AGENTS\.md/);
	assert.match(unmarked.stderr, new RegExp(`^ {2}${BEGIN}$`, "m"));
	assert.equal(readFileSync(join(unmarkedBridge, "AGENTS.md"), "utf8"), untouched);
	assert.equal(existsSync(join(unmarkedBridge, ".nosedive", "config.yaml")), false);

	// --file repeats.
	const multiBridge = newBridge("multi-bridge");
	const multi = run(
		["seed", "--headless", "--file", "AGENTS.md", "--file=.github/copilot-instructions.md"],
		multiBridge,
		"",
	);
	assertOk(multi, "seed with repeated --file failed");
	assertManagedBlock(readFileSync(join(multiBridge, "AGENTS.md"), "utf8"), "AGENTS.md");
	assertManagedBlock(
		readFileSync(join(multiBridge, ".github", "copilot-instructions.md"), "utf8"),
		"copilot-instructions.md",
	);

	const missingValue = run(["seed", "--headless", "--file"], multiBridge, "");
	assert.notEqual(missingValue.status, 0, "seed --file without a path unexpectedly succeeded");
	assert.match(missingValue.stderr, /seed --file requires a path/);
});
