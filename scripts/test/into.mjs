import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { createTmp, run, runTool, write, writeBridgeConfig } from "../test-helpers.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");
const tmp = createTmp("into");

test("into warns and delegates to the plan prompt", () => {
	const bridge = join(tmp, "bridge");
	const backlogId = "019fcf20-0000-7000-8000-000000000001";
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Into Test"], bridge);
	runTool("git", ["config", "user.email", "into@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: backlogId });
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---
kind: memo
id: ${backlogId}
name: backlog.into-test
gist: "Into test backlog"
---

# Backlog
`,
	);

	const result = run(["into", "test handoff"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /warning: into is deprecated; use plan instead/);
	assert.match(result.stdout, /vertical slices at its logical seams/);
	assert.match(result.stdout, /no more than half a day's work/);
	assert.match(result.stdout, /rel: land\.gate/);
	assert.match(result.stdout, /Stop once all slices are recorded/);
	assert.doesNotMatch(result.stdout, /Then run .*jump/);
});

function heldBridge(name, diver) {
	const bridge = join(tmp, name);
	const diveId = "019fcf20-0000-7000-8000-000000000002";
	const backlogId = "019fcf20-0000-7000-8000-000000000001";
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Into Test"], bridge);
	runTool("git", ["config", "user.email", "into@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: backlogId });
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---
kind: memo
id: ${backlogId}
name: backlog.into-test
---

# Backlog
`,
	);
	write(
		join(bridge, "kb", `${diveId}.md`),
		`---
kind: dive
id: ${diveId}
name: held.into-test
gist: "Held test dive"
meta:
  diver: ${diver ?? "null"}
links:
  - kb/019fcf20-0000-7000-8000-000000000003.md:
      rel: patch
---
`,
	);
	writeFileSync(join(bridge, "workspace", ".nosedive-ref"), `id: ${diveId}\n`);
	return { bridge, diveId };
}

test("into distinguishes own, foreign, and unheld marked dives", () => {
	const own = heldBridge("own", "into@example.test");
	const ownResult = run(["into"], own.bridge);
	assert.notEqual(ownResult.status, 0);
	assert.match(ownResult.stderr, /pack, bail, or land/);

	const foreign = heldBridge("foreign", "other@example.test");
	const foreignResult = run(["into"], foreign.bridge);
	assert.notEqual(foreignResult.status, 0);
	assert.match(foreignResult.stderr, /held by other@example\.test/);
	assert.match(foreignResult.stderr, new RegExp(`--ref ${foreign.diveId} --takeover`));

	const free = heldBridge("free", undefined);
	const freeResult = run(["into"], free.bridge);
	assert.equal(freeResult.status, 0, freeResult.stderr);
	assert.match(freeResult.stdout, new RegExp(`unheld marked dive ${free.diveId}`));
	assert.match(freeResult.stdout, /Held test dive.*1 patch chain/);
	assert.match(freeResult.stdout, new RegExp(`record\.dive --ref ${free.diveId}`));
});

function walk(dir, out) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else out.push(path);
	}
}

test("no file under src/, scripts/, or README.md recommends running into", () => {
	// into's own deprecation-warning source and its own test are allowed to
	// name the word; every other place should point at `plan` instead.
	const allowed = new Set(
		["src/impl/i0995c54d2e345db7839c9268c38c3ab0.ts", "scripts/test/into.mjs"].map((rel) =>
			join(repoRoot, rel),
		),
	);
	const recommendationPattern =
		/(run|start(?:ed|ing)? (?:it|one|a new one)) (?:it )?(?:with )?`?nosedive into\b|with `into`|start.{0,20}with `into`/i;

	const files = [];
	walk(join(repoRoot, "src"), files);
	walk(join(repoRoot, "scripts"), files);
	files.push(join(repoRoot, "README.md"));

	const offenders = [];
	for (const path of files) {
		if (allowed.has(path)) continue;
		const text = readFileSync(path, "utf8");
		if (recommendationPattern.test(text)) offenders.push(relative(repoRoot, path));
	}
	assert.deepEqual(offenders, [], `these files recommend running into:\n${offenders.join("\n")}`);
});
