import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	pitchFeat,
	recordedDiveId,
	run,
	runTool,
	seededBridge,
	write,
} from "../test-helpers.mjs";

const tmp = createTmp("first-gate-arc");

/** A plain implementation repo with one commit, for `record.repo` to register. */
function implSource(name) {
	const path = join(tmp, `${name}-source`);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "-b", "main"], path);
	write(join(path, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], path);
	gitCommit(path, "base");
	return path;
}

/** The id `record.repo` reports having written the repo doc at. */
function recordedRepoId(stdout) {
	const match = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(stdout);
	assert.ok(match, `record.repo did not report a written doc:\n${stdout}`);
	return match[1];
}

/** The stub path a gate's error message names. */
function stubPathFor(gateId) {
	return join("kb", "artifacts", `${gateId}.mjs`);
}

test("a pilot's first gate: minted from a gist, red until written, green once it is", () => {
	const diver = "pilot@example.test";
	const { bridge, origin } = seededBridge(tmp, "first-gate-arc", diver);

	// 1. Seed a bridge, register a repo, pitch a feat, record a dive on it, jump.
	const source = implSource("first-gate-arc-impl");
	const registered = run(["record.repo", source, "--name", "first-gate-arc-impl"], bridge);
	assertOk(registered, "record.repo failed");
	const repoId = recordedRepoId(registered.stdout);
	assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate-repo.workspace failed");

	const { featId } = pitchFeat(bridge, "Keep the export list honest.", "export-honesty");
	const dive = run(
		[
			"record.dive",
			"--feat",
			featId,
			"--diver",
			diver,
			"--brief",
			"Prove the export list stays honest.",
			"--upscope",
			repoId,
			"--work-branch",
			"work/export-honesty",
		],
		bridge,
	);
	assertOk(dive, "record.dive failed");
	const diveId = recordedDiveId(dive.stdout);

	assertOk(run(["jump", diveId], bridge), "jump failed");
	const worktree = join(bridge, "workspace", "first-gate-arc-impl");
	assert.equal(existsSync(worktree), true, "jump should have hydrated the scoped repo");

	// 2. record.gate mints the gate doc, the stub, and the feat's test.gate link,
	// and its name is derived from the gist rather than a clock.
	const gist = "The export list matches what the package actually exports.";
	const recorded = run(["record.gate", gist, "--feat", featId], bridge);
	assertOk(recorded, "record.gate failed");
	const gateMatch = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(recorded.stdout);
	assert.ok(gateMatch, `record.gate did not report a written doc:\n${recorded.stdout}`);
	const gateId = gateMatch[1];

	const gateDocPath = join(bridge, "kb", `${gateId}.md`);
	assert.equal(existsSync(gateDocPath), true, "the gate doc should exist");
	const gateDoc = readFileSync(gateDocPath, "utf8");
	assert.match(gateDoc, /^kind: gate$/m);
	assert.match(
		gateDoc,
		/^name: the-export-list-matches-what-the-package$/m,
		"the gate's name should be derived from its gist, not a timestamp",
	);
	assert.doesNotMatch(gateDoc, /^name: new-gate-\d{4}-\d{2}-\d{2}-\d{6}$/m);

	const stubPath = join(bridge, stubPathFor(gateId));
	assert.equal(existsSync(stubPath), true, "the stub script should exist");

	const featPath = join(bridge, "kb", `${featId}.md`);
	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`- kb/${gateId}\\.md:\\n      rel: test\\.gate`),
		"the feat should declare test.gate",
	);
	assert.match(
		recorded.stdout,
		new RegExp(`It fails until written\\. Run it with: nosedive test ${gateId}`),
		"record.gate should print the exact command to run the fresh gate",
	);

	// 3. The unedited stub fails, and names the file to edit.
	const firstRun = run(["test", gateId], bridge);
	assert.notEqual(firstRun.status, 0, "a freshly minted gate must fail");
	assert.match(
		firstRun.stderr,
		new RegExp(
			`gate ${gateId} is unimplemented -- write the check in ${stubPathFor(gateId).replaceAll("\\", "/")}`,
		),
		"the failure should name the stub file to edit",
	);

	// 4. A failing gate attaches itself to the working dive, so the failure is on
	// the record rather than only in a terminal that has scrolled away.
	assert.match(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
		new RegExp(`- kb/${gateId}\\.md:\\n      rel: test\\.gate`),
		"a failing gate should attach itself to the dive it failed on",
	);

	// `record.gate` mints `rel: test.gate`; `land` collects `rel: land.gate` --
	// see `collectFeatGates("land", ...)` in the land implementation. Different
	// verbs on purpose: `nosedive test` is the loop a pilot runs while working,
	// and a land gate is what publication is conditional on. So the gate minted
	// here does not gate the land, and the feat declares no land gate at all.
	// If that split is ever revisited, this is the assertion that changes with it.
	assert.doesNotMatch(
		readFileSync(featPath, "utf8"),
		/rel: land\.gate/,
		"record.gate mints a test gate, not a land gate",
	);

	// 5. Rewrite the stub so it passes.
	writeFileSync(
		stubPath,
		"export async function run() {\n\tconsole.error('export list is honest');\n\treturn true;\n}\n",
	);
	// 6. nosedive test <gate-id> now passes. By this point the feat and the dive
	// the sweep minted both declare the gate, so this also holds the rule that
	// the active dive is the declaration a named gate inherits from.
	const secondRun = run(["test", gateId], bridge);
	assertOk(secondRun, "the rewritten gate should pass");

	// 7. land succeeds and the work branch is pushed. The dive stayed open through
	// the red gate, so this is the first land the arc reaches. It needs a commit
	// in the worktree to push: a scope sitting at its pin is not something land
	// publishes.
	write(join(worktree, "EXPORTS.md"), "one honest export\n");
	runTool("git", ["add", "EXPORTS.md"], worktree);
	gitCommit(worktree, "record the export list");

	const landed = run(["land"], bridge);
	assertOk(landed, "land should succeed once the gate passes");
	// Asked of the repo land pushed TO, not of the worktree. The worktree's remote
	// is the managed cache and it has not fetched, so `git branch --all` there
	// reports nothing about a branch that certainly exists.
	assert.match(
		runTool("git", ["ls-remote", "--heads", source], bridge).stdout,
		/refs\/heads\/work\/export-honesty$/m,
		"the work branch should be pushed once the gate passes",
	);

	// The bridge itself should also have landed, closing the dive.
	assert.match(
		runTool("git", ["show", "main:kb/" + diveId + ".md"], bridge).stdout,
		/^kind: memo$/m,
	);
	assert.equal(
		runTool("git", ["rev-parse", "main"], bridge).stdout.trim(),
		runTool("git", ["rev-parse", "main"], origin).stdout.trim(),
		"land should have pushed the bridge to its remote",
	);
});
