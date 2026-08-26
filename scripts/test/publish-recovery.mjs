import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { decidePublishRecovery } from "../decide-publish-recovery.mjs";
import { createTmp, root, runTool, write } from "../test-helpers.mjs";
import { commitAll, finalize, sourceRepo, VERSION } from "./fixtures/publish-repo.mjs";

const tmp = createTmp("publish-recovery");

const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";

test("main still at the source means the whole run may start over", () => {
	const { dir, source } = sourceRepo(tmp, "rerun");
	assert.deepEqual(decidePublishRecovery({ repo: dir, source, main: "main" }), {
		state: "rerun",
		source,
		main: source,
	});
});

test("main at this run's finalization resumes with the version it already carries", () => {
	const { dir, source } = sourceRepo(tmp, "resume");
	const commit = finalize(dir, { sourceTrailer: source });
	assert.deepEqual(decidePublishRecovery({ repo: dir, source, main: "main" }), {
		state: "resume",
		source,
		main: commit,
		version: VERSION,
	});
});

test("main carrying somebody else's work is superseded", () => {
	const { dir, source } = sourceRepo(tmp, "superseded");
	write(join(dir, "src", "nosedive.ts"), "export const version = 2;\n");
	const later = commitAll(dir, "Land something after the source");
	const decision = decidePublishRecovery({ repo: dir, source, main: "main" });
	assert.equal(decision.state, "superseded");
	assert.equal(decision.main, later);
	assert.equal(decision.version, undefined);
});

test("a finalization of another source is superseded, not resumed", () => {
	const { dir, source } = sourceRepo(tmp, "foreign-finalization");
	finalize(dir, { sourceTrailer: OTHER_SHA });
	const decision = decidePublishRecovery({ repo: dir, source, main: "main" });
	assert.equal(decision.state, "superseded");
	assert.match(decision.reason, /^source-trailer: /);
});

test("main one commit past a valid finalization is superseded, not resumed", () => {
	const { dir, source } = sourceRepo(tmp, "past-finalization");
	finalize(dir, { sourceTrailer: source });
	write(join(dir, "src", "nosedive.ts"), "export const version = 2;\n");
	const later = commitAll(dir, "Land something after the finalization");
	const decision = decidePublishRecovery({ repo: dir, source, main: "main" });
	assert.equal(decision.state, "superseded");
	assert.equal(decision.main, later);
	assert.match(decision.reason, /^parent: /);
});

test("the cli prints only what a workflow step can read into variables", () => {
	const script = join(root, "scripts", "decide-publish-recovery.mjs");
	const printed = runTool(process.execPath, [script, "HEAD", "HEAD"], root).stdout;
	assert.equal(printed, "state=rerun\nversion=\n");
});
