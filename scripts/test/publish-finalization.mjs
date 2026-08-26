import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { checkPublishFinalization } from "../check-publish-finalization.mjs";
import { createTmp, gitCommit, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("publish-finalization");

const VERSION = "2026.8.25-1787693697086";
const SURFACES = ["command-surface", "faq"];

/**
 * A stand-in for one README surface generator. The real ones parse kb/ with
 * `yaml`, which a fixture repository outside the package cannot resolve; what
 * the check depends on is the contract these share -- read this tree's
 * README.md, exit non-zero under `--check` when it is stale.
 */
function generator(marker) {
	return [
		'import { readFileSync } from "node:fs";',
		'import { dirname, join, resolve } from "node:path";',
		'import { fileURLToPath } from "node:url";',
		'const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");',
		'if (!process.argv.includes("--check")) {',
		'\tconsole.error("expected --check");',
		"\tprocess.exit(2);",
		"}",
		`if (!readFileSync(join(root, "README.md"), "utf8").includes("<!-- ${marker} fresh -->")) {`,
		`\tconsole.error("${marker} surface is stale");`,
		"\tprocess.exit(1);",
		"}",
		"",
	].join("\n");
}

function readme(staleSurface) {
	const fresh = SURFACES.filter((surface) => surface !== staleSurface);
	return ["# fixture", "", ...fresh.map((surface) => `<!-- ${surface} fresh -->`), ""].join("\n");
}

function packageFiles(dir, { packageJsonVersion, lockVersion }) {
	write(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "nosedive", version: packageJsonVersion }, null, 2)}\n`,
	);
	write(
		join(dir, "package-lock.json"),
		`${JSON.stringify(
			{
				name: "nosedive",
				version: lockVersion,
				packages: { "": { name: "nosedive", version: lockVersion } },
			},
			null,
			2,
		)}\n`,
	);
}

function commitAll(dir, message) {
	// Forced, because a pilot whose global ignore lists package-lock.json would
	// otherwise get a fixture that never commits the file the check reads.
	runTool("git", ["add", "-A", "-f"], dir);
	gitCommit(dir, message);
	return runTool("git", ["rev-parse", "HEAD"], dir).stdout.trim();
}

/** A repository holding one source commit, shaped the way the package is. */
function sourceRepo(label) {
	const dir = join(tmp, label);
	mkdirSync(dir, { recursive: true });
	runTool("git", ["init", "-b", "main"], dir);
	write(join(dir, "README.md"), readme());
	write(join(dir, "src", "nosedive.ts"), "export const version = 1;\n");
	write(join(dir, "scripts", "update-readme-command-surface.mjs"), generator("command-surface"));
	write(join(dir, "scripts", "update-readme-faq.mjs"), generator("faq"));
	packageFiles(dir, { packageJsonVersion: "0.0.0-dev", lockVersion: "0.0.0-dev" });
	return { dir, source: commitAll(dir, "base") };
}

/** The commit a managed publish would make. Every option names one way to spoil it. */
function finalize(
	dir,
	{
		version = VERSION,
		packageJsonVersion = version,
		lockVersion = version,
		sourceTrailer,
		versionTrailer = version,
		staleSurface,
		extraPath,
	} = {},
) {
	packageFiles(dir, { packageJsonVersion, lockVersion });
	if (staleSurface) write(join(dir, "README.md"), readme(staleSurface));
	if (extraPath) write(join(dir, extraPath), "touched by the finalization\n");
	const message = ["Stamp the published version", ""];
	if (sourceTrailer) message.push(`Nosedive-Publish-Source: ${sourceTrailer}`);
	if (versionTrailer) message.push(`Nosedive-Publish-Version: ${versionTrailer}`);
	return commitAll(dir, message.join("\n"));
}

test("a stamped commit on its source is a valid finalization", () => {
	const { dir, source } = sourceRepo("valid");
	const commit = finalize(dir, { sourceTrailer: source });
	assert.deepEqual(checkPublishFinalization({ repo: dir, commit, source }), {
		ok: true,
		commit,
		source,
		version: VERSION,
	});
});

test("a finalization sitting on another commit fails on its parent", () => {
	const { dir, source } = sourceRepo("wrong-parent");
	write(join(dir, "src", "nosedive.ts"), "export const version = 2;\n");
	commitAll(dir, "Land something after the source");
	const commit = finalize(dir, { sourceTrailer: source });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "parent");
	assert.match(result.detail, new RegExp(`expected parent ${source}`));
});

test("a finalization with no source trailer says so", () => {
	const { dir, source } = sourceRepo("no-source-trailer");
	const commit = finalize(dir);
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "source-trailer");
	assert.match(result.detail, /carries no Nosedive-Publish-Source/);
});

test("a source trailer naming another commit fails", () => {
	const { dir, source } = sourceRepo("foreign-source-trailer");
	const other = "0123456789abcdef0123456789abcdef01234567";
	const commit = finalize(dir, { sourceTrailer: other });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "source-trailer");
	assert.match(result.detail, new RegExp(`names ${other}, not ${source}`));
});

test("a finalization with no version trailer says so", () => {
	const { dir, source } = sourceRepo("no-version-trailer");
	const commit = finalize(dir, { sourceTrailer: source, versionTrailer: null });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "version-trailer");
	assert.match(result.detail, /carries no Nosedive-Publish-Version/);
});

test("a version trailer that is not a timestamped dev version fails", () => {
	const { dir, source } = sourceRepo("untimestamped-version");
	const commit = finalize(dir, { version: "2026.8.25", sourceTrailer: source });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "version-trailer");
	assert.match(result.detail, /not a timestamped dev version/);
});

test("a version trailer disagreeing with package.json fails", () => {
	const { dir, source } = sourceRepo("package-json-disagrees");
	const commit = finalize(dir, { sourceTrailer: source, packageJsonVersion: "2026.8.25-1" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "package-version");
	assert.match(result.detail, /package\.json is 2026\.8\.25-1/);
});

test("a version trailer disagreeing with package-lock.json fails", () => {
	const { dir, source } = sourceRepo("lock-disagrees");
	const commit = finalize(dir, { sourceTrailer: source, lockVersion: "2026.8.25-1" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "package-version");
	assert.match(result.detail, /package-lock\.json is 2026\.8\.25-1/);
});

test("a finalization touching a fourth path fails", () => {
	const { dir, source } = sourceRepo("fourth-path");
	const commit = finalize(dir, { sourceTrailer: source, extraPath: "src/nosedive.ts" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "changed-paths");
	assert.match(result.detail, /changed src\/nosedive\.ts/);
});

test("a finalization whose README surfaces are stale fails", () => {
	const { dir, source } = sourceRepo("stale-surface");
	const commit = finalize(dir, { sourceTrailer: source, staleSurface: "faq" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "readme-surface");
	assert.match(result.detail, /update-readme-faq\.mjs --check failed: faq surface is stale/);
});

test("a stale command surface is caught as well as a stale faq", () => {
	const { dir, source } = sourceRepo("stale-command-surface");
	const commit = finalize(dir, { sourceTrailer: source, staleSurface: "command-surface" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "readme-surface");
	assert.match(result.detail, /update-readme-command-surface\.mjs --check failed/);
});

test("a checked finalization leaves no worktree behind", () => {
	const { dir, source } = sourceRepo("worktree-cleanup");
	const commit = finalize(dir, { sourceTrailer: source });
	checkPublishFinalization({ repo: dir, commit, source });
	const worktrees = runTool("git", ["worktree", "list"], dir).stdout.trim().split("\n");
	assert.equal(worktrees.length, 1, `left a worktree behind:\n${worktrees.join("\n")}`);
});
