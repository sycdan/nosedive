import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { decideStableRelease } from "../decide-stable-release.mjs";
import { createTmp, runTool, write } from "../test-helpers.mjs";
import { commitAll, finalize, sourceRepo, VERSION } from "./fixtures/publish-repo.mjs";

const tmp = createTmp("stable-release");

const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";

function tag(dir, name, commit) {
	runTool("git", ["tag", name, commit], dir);
}

test("a finalization promotes to the date its own dev version carries", () => {
	const { dir, source } = sourceRepo(tmp, "promote");
	const commit = finalize(dir, { sourceTrailer: source });
	assert.deepEqual(decideStableRelease({ repo: dir, source: commit, ref: "main" }), {
		source: commit,
		dev: VERSION,
		stable: "2026.8.25",
		tag: "v2026.8.25",
	});
});

test("a dispatch that did not target main releases nothing", () => {
	const { dir, source } = sourceRepo(tmp, "wrong-branch");
	const commit = finalize(dir, { sourceTrailer: source });
	assert.throws(
		() => decideStableRelease({ repo: dir, source: commit, ref: "work/something" }),
		/dispatched on main, not work\/something/,
	);
});

test("an ordinary commit is not a stable candidate, and says which condition it failed", () => {
	const { dir } = sourceRepo(tmp, "not-finalized");
	write(join(dir, "src", "nosedive.ts"), "export const version = 2;\n");
	const commit = commitAll(dir, "Land something ordinary");
	assert.throws(
		() => decideStableRelease({ repo: dir, source: commit, ref: "main" }),
		/is not a managed finalization \(source-trailer\)/,
	);
});

test("a finalization whose trailers do not match its own parent is refused", () => {
	const { dir } = sourceRepo(tmp, "foreign-trailer");
	const commit = finalize(dir, { sourceTrailer: OTHER_SHA });
	assert.throws(
		() => decideStableRelease({ repo: dir, source: commit, ref: "main" }),
		/is not a managed finalization \(source-trailer\)/,
	);
});

test("the release tag already on this candidate means a rerun, not a second release", () => {
	const { dir, source } = sourceRepo(tmp, "rerun-dispatch");
	const commit = finalize(dir, { sourceTrailer: source });
	tag(dir, "v2026.8.25", commit);
	const decision = decideStableRelease({ repo: dir, source: commit, ref: "main" });
	assert.equal(decision.stable, "2026.8.25");
	assert.equal(decision.tag, "v2026.8.25");
});

test("a release tag held by another candidate is refused rather than moved", () => {
	const { dir, source } = sourceRepo(tmp, "date-taken");
	tag(dir, "v2026.8.25", source);
	const commit = finalize(dir, { sourceTrailer: source });
	assert.throws(
		() => decideStableRelease({ repo: dir, source: commit, ref: "main" }),
		/v2026\.8\.25 already releases .*; refusing to move it to/,
	);
});
