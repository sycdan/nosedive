import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { checkPublishFinalization } from "../check-publish-finalization.mjs";
import { createTmp, runTool, write } from "../test-helpers.mjs";
import { commitAll, finalize, sourceRepo, VERSION } from "./fixtures/publish-repo.mjs";

const tmp = createTmp("publish-finalization");

test("a stamped commit on its source is a valid finalization", () => {
	const { dir, source } = sourceRepo(tmp, "valid");
	const commit = finalize(dir, { sourceTrailer: source });
	assert.deepEqual(checkPublishFinalization({ repo: dir, commit, source }), {
		ok: true,
		commit,
		source,
		version: VERSION,
	});
});

test("a finalization sitting on another commit fails on its parent", () => {
	const { dir, source } = sourceRepo(tmp, "wrong-parent");
	write(join(dir, "src", "nosedive.ts"), "export const version = 2;\n");
	commitAll(dir, "Land something after the source");
	const commit = finalize(dir, { sourceTrailer: source });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "parent");
	assert.match(result.detail, new RegExp(`expected parent ${source}`));
});

test("a finalization with no source trailer says so", () => {
	const { dir, source } = sourceRepo(tmp, "no-source-trailer");
	const commit = finalize(dir);
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "source-trailer");
	assert.match(result.detail, /carries no Nosedive-Publish-Source/);
});

test("a source trailer naming another commit fails", () => {
	const { dir, source } = sourceRepo(tmp, "foreign-source-trailer");
	const other = "0123456789abcdef0123456789abcdef01234567";
	const commit = finalize(dir, { sourceTrailer: other });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "source-trailer");
	assert.match(result.detail, new RegExp(`names ${other}, not ${source}`));
});

test("a finalization with no version trailer says so", () => {
	const { dir, source } = sourceRepo(tmp, "no-version-trailer");
	const commit = finalize(dir, { sourceTrailer: source, versionTrailer: null });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "version-trailer");
	assert.match(result.detail, /carries no Nosedive-Publish-Version/);
});

test("a version trailer that is not a timestamped dev version fails", () => {
	const { dir, source } = sourceRepo(tmp, "untimestamped-version");
	const commit = finalize(dir, { version: "2026.8.25", sourceTrailer: source });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "version-trailer");
	assert.match(result.detail, /not a timestamped dev version/);
});

test("a version trailer disagreeing with package.json fails", () => {
	const { dir, source } = sourceRepo(tmp, "package-json-disagrees");
	const commit = finalize(dir, { sourceTrailer: source, packageJsonVersion: "2026.8.25-1" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "package-version");
	assert.match(result.detail, /package\.json is 2026\.8\.25-1/);
});

test("a version trailer disagreeing with package-lock.json fails", () => {
	const { dir, source } = sourceRepo(tmp, "lock-disagrees");
	const commit = finalize(dir, { sourceTrailer: source, lockVersion: "2026.8.25-1" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "package-version");
	assert.match(result.detail, /package-lock\.json is 2026\.8\.25-1/);
});

test("a finalization touching a fourth path fails", () => {
	const { dir, source } = sourceRepo(tmp, "fourth-path");
	const commit = finalize(dir, { sourceTrailer: source, extraPath: "src/nosedive.ts" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "changed-paths");
	assert.match(result.detail, /changed src\/nosedive\.ts/);
});

test("a finalization whose README surfaces are stale fails", () => {
	const { dir, source } = sourceRepo(tmp, "stale-surface");
	const commit = finalize(dir, { sourceTrailer: source, staleSurface: "faq" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "readme-surface");
	assert.match(result.detail, /update-readme-faq\.mjs --check failed: faq surface is stale/);
});

test("a stale command surface is caught as well as a stale faq", () => {
	const { dir, source } = sourceRepo(tmp, "stale-command-surface");
	const commit = finalize(dir, { sourceTrailer: source, staleSurface: "command-surface" });
	const result = checkPublishFinalization({ repo: dir, commit, source });
	assert.equal(result.condition, "readme-surface");
	assert.match(result.detail, /update-readme-command-surface\.mjs --check failed/);
});

test("a checked finalization leaves no worktree behind", () => {
	const { dir, source } = sourceRepo(tmp, "worktree-cleanup");
	const commit = finalize(dir, { sourceTrailer: source });
	checkPublishFinalization({ repo: dir, commit, source });
	const worktrees = runTool("git", ["worktree", "list"], dir).stdout.trim().split("\n");
	assert.equal(worktrees.length, 1, `left a worktree behind:\n${worktrees.join("\n")}`);
});
