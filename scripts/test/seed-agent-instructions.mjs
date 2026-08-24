import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createTmp, giveOrigin, run, runTool, write } from "../test-helpers.mjs";
import { createRequire } from "node:module";

const tmp = createTmp("seed-agent-instructions");

const BEGIN = "<!-- BEGIN nosedive managed instructions -->";
const END = "<!-- END nosedive managed instructions -->";
const MARKER_PAIR = ["```md", BEGIN, END, "```"].join("\n");
/**
 * Mirrors `SURFACE_STAMP_PATTERN` in src/lib/packageBacklog.ts, which the
 * library entry does not re-export. Asserting through the pattern rather than a
 * literal keeps these tests from having to be rewritten every time the stamp
 * grows a field -- the ` commit=<sha>` segment already cost that once.
 */
const SURFACE_STAMP_PATTERN =
	/^<!-- nosedive v=(\S+?)(?: commit=([0-9a-f]{7,40}))? surface=([0-9a-f]{8}) -->$/m;
const require = createRequire(import.meta.url);
const { describeInstructionDrift, renderedSurfaceDigest } = require(
	join(process.cwd(), "dist", "nosedive.js"),
);

function newBridge(name) {
	const bridgeDir = join(tmp, name);
	mkdirSync(bridgeDir, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridgeDir);
	runTool("git", ["config", "user.name", "Instructions Person"], bridgeDir);
	runTool("git", ["config", "user.email", "instructions@example.invalid"], bridgeDir);
	giveOrigin(tmp, bridgeDir, name);
	return bridgeDir;
}

function assertManagedBlock(text, label) {
	assert.match(text, new RegExp(`^${BEGIN}$`, "m"), `${label} is missing the begin marker`);
	assert.match(text, new RegExp(`^${END}$`, "m"), `${label} is missing the end marker`);
	assert.doesNotMatch(text, /npx -y nosedive@/);
	assert.doesNotMatch(text, /dist[\\/]cli\.js/);
	assert.match(text, SURFACE_STAMP_PATTERN, `${label} is missing the surface stamp line`);
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

const STAMPED_DIGEST = "abc12345";
const INSTALLED_DIGEST = "abc12346";
const SHA = "a".repeat(40);
/** A drift question with the parts every case shares already filled in. */
function drift(question) {
	return describeInstructionDrift({
		file: "AGENTS.md",
		installedVersion: "2026.8.21",
		installedDigest: INSTALLED_DIGEST,
		...question,
	});
}

test("describeInstructionDrift stays quiet when the digests agree", () => {
	// A pilot whose install is older but whose surface is identical has nothing
	// to report, so the version never gets a say once the digests match.
	assert.equal(drift({ stamped: { version: "2026.9.1", digest: INSTALLED_DIGEST } }), undefined);
	assert.equal(drift({ stamped: { version: "2026.8.9", digest: INSTALLED_DIGEST } }), undefined);
	assert.equal(
		drift({ stamped: { version: "0.0.0-dev", commit: SHA, digest: INSTALLED_DIGEST } }),
		undefined,
	);
});

test("describeInstructionDrift reports an unstamped block without ordering a reseed", () => {
	const message = drift({});
	assert.match(message, /^nose: /);
	assert.match(message, /carry no version stamp/);
	// An unstamped block could describe any surface, so the reseed is offered on
	// a condition the pilot has to check, never ordered outright.
	assert.doesNotMatch(message, /Run: nosedive seed/);
});

test("describeInstructionDrift names the stamped version when the install is older", () => {
	const message = drift({ stamped: { version: "2026.9.1", digest: STAMPED_DIGEST } });
	assert.match(message, /^nose: /);
	assert.match(message, /Run: npm i -g nosedive@2026\.9\.1$/);
	// `@latest` is a different version from the one that wrote the block, and
	// seeding from this older install would drop commands the block lists right.
	assert.doesNotMatch(message, /nosedive@latest/);
	assert.doesNotMatch(message, /Run: nosedive seed/);
});

test("describeInstructionDrift orders a reseed when the install is newer", () => {
	const message = drift({ stamped: { version: "2026.8.9", digest: STAMPED_DIGEST } });
	assert.match(message, /^nose: /);
	assert.match(message, /Run: nosedive seed$/);
});

test("describeInstructionDrift orders a reseed when the versions match and the digests do not", () => {
	// The same version renders the same surface, so a differing digest proves the
	// block came from somewhere else and reseeding cannot lose anything.
	const message = drift({ stamped: { version: "2026.8.21", digest: STAMPED_DIGEST } });
	assert.match(message, /^nose: /);
	assert.match(message, /Run: nosedive seed$/);
});

test("describeInstructionDrift orders a reseed when the stamped commit is already in this checkout", () => {
	const message = drift({
		installedVersion: "0.0.0-dev",
		stamped: { version: "0.0.0-dev", commit: SHA, digest: STAMPED_DIGEST },
		containsCommit: () => true,
	});
	assert.match(message, /Run: nosedive seed$/);
	// Two of the pilot's own checkouts disagreeing is real but never clears on
	// its own, and a call to attention that is always there stops being read.
	assert.doesNotMatch(message, /^nose: /);
});

test("describeInstructionDrift will not order a reseed from an unreachable commit", () => {
	const message = drift({
		installedVersion: "0.0.0-dev",
		stamped: { version: "0.0.0-dev", commit: SHA, digest: STAMPED_DIGEST },
		containsCommit: () => false,
	});
	// A sibling branch proves nothing about which side is newer, and seeding from
	// the older one silently removes commands the block listed correctly.
	assert.match(message, /nosedive cannot tell which is newer/);
	assert.doesNotMatch(message, /Run: nosedive seed/);
	assert.doesNotMatch(message, /^nose: /);
});

test("describeInstructionDrift will not order a reseed when the stamp carries no commit", () => {
	const message = drift({
		installedVersion: "0.0.0-dev",
		stamped: { version: "0.0.0-dev", digest: STAMPED_DIGEST },
	});
	assert.match(message, /nosedive cannot tell which is newer/);
	assert.doesNotMatch(message, /Run: nosedive seed/);
	assert.doesNotMatch(message, /^nose: /);
});

test("describeInstructionDrift calls attention when only one side carries a version", () => {
	// An install reading a block a source checkout stamped is not the pilot's own
	// two checkouts disagreeing: it is someone else's state, it will not clear on
	// its own, and nothing here can order the fix. That earns the `nose:` call.
	const message = drift({ stamped: { version: "0.0.0-dev", digest: STAMPED_DIGEST } });
	assert.match(message, /nosedive cannot tell which is newer/);
	assert.doesNotMatch(message, /Run: nosedive seed/);
	assert.match(message, /^nose: /);
});

test("seed-agent-instructions", () => {
	const digest = renderedSurfaceDigest();
	assert.match(digest, /^[0-9a-f]{8}$/);
	assert.equal(digest, renderedSurfaceDigest());

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
	const seededInstructions = readFileSync(join(bareBridge, "AGENTS.md"), "utf8");
	const managedBlock =
		/<!-- BEGIN nosedive managed instructions -->([\s\S]*?)<!-- END nosedive managed instructions -->/m.exec(
			seededInstructions,
		)?.[1];
	assert.ok(managedBlock, "seeded AGENTS.md has no managed block");
	const stampLine = managedBlock.split("\n")[1];
	const stamp = SURFACE_STAMP_PATTERN.exec(stampLine);
	assert.ok(stamp, `unexpected surface stamp line: ${stampLine}`);
	const [, stampedVersion, stampedCommit, stampedDigest] = stamp;
	assert.equal(stampedVersion, require(join(process.cwd(), "package.json")).version);
	assert.equal(stampedDigest, digest);
	// Seeding from a checkout stamps the commit it rendered from; an install that
	// is not its own repository stamps none, and scripts/test-pack-bin.mjs pins
	// that side. Either is well-formed here, so only the shape is asserted.
	assert.equal(
		stampedCommit === undefined || /^[0-9a-f]{40}$/.test(stampedCommit),
		true,
		`unexpected stamped commit: ${stampedCommit}`,
	);
	assert.doesNotMatch(managedBlock, /npx -y nosedive@/);
	assert.doesNotMatch(managedBlock, /dist[\\/]cli\.js/);
	// Seed runs at the start of every session. A block that differs run to run
	// would show up as a diff in every pilot's working tree, so the stamp has to
	// be a function of the package alone.
	assertOk(run(["seed", "--headless"], bareBridge, ""), "second seed failed");
	assert.equal(readFileSync(join(bareBridge, "AGENTS.md"), "utf8"), seededInstructions);
	const backlogMemos = readdirSync(join(bareBridge, "kb"))
		.filter((entry) => entry.endsWith(".md"))
		.filter((entry) => /^kind: memo$/m.test(readFileSync(join(bareBridge, "kb", entry), "utf8")));
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
	assert.ok(mixed.stderr.includes(MARKER_PAIR), "mixed stderr is missing the fenced marker pair");
	assert.equal(readFileSync(join(mixedBridge, "CLAUDE.md"), "utf8"), untouched);
	assertManagedBlock(readFileSync(join(mixedBridge, "AGENTS.md"), "utf8"), "AGENTS.md");

	// No target could be seeded at all: fatal, and nothing is written.
	const unmarkedBridge = newBridge("unmarked-bridge");
	write(join(unmarkedBridge, "AGENTS.md"), untouched);
	const unmarked = run(["seed", "--headless"], unmarkedBridge, "");
	assert.notEqual(unmarked.status, 0, "seed with no seedable file unexpectedly succeeded");
	assert.match(unmarked.stderr, /no agent instructions file could be seeded: AGENTS\.md/);
	assert.ok(
		unmarked.stderr.includes(MARKER_PAIR),
		"unmarked stderr is missing the fenced marker pair",
	);
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
