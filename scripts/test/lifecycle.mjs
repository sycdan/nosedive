import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createBridge,
	createTmp,
	gitCommit,
	run,
	runTool,
	write,
} from "../test-helpers.mjs";

const tmp = createTmp("lifecycle");
const diver = "lifecycle@example.test";
const repoId = "019fd590-0000-7000-8000-000000000001";
const diveGateId = "019fd590-0000-7000-8000-000000000002";
const featGateId = "019fd590-0000-7000-8000-000000000003";

function bareRepo(name) {
	const path = join(tmp, name);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], path);
	return path;
}

function recordedId(stdout) {
	const id = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(stdout)?.[1];
	assert.ok(id, `record.dive did not report a dive id:\n${stdout}`);
	return id;
}

test("a feat composes through packed, bailed, and landed dives", () => {
	const local = bareRepo("implementation-local.git");
	const cloud = bareRepo("implementation-cloud.git");
	const source = join(tmp, "implementation-source");
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, "base implementation");
	runTool("git", ["remote", "add", "local", local], source);
	runTool("git", ["remote", "add", "cloud", cloud], source);
	runTool("git", ["push", "local", "main"], source);
	runTool("git", ["push", "cloud", "main"], source);

	const bridge = createBridge(tmp, "bridge");
	runTool("git", ["config", "user.name", "Lifecycle Test"], bridge);
	runTool("git", ["config", "user.email", diver], bridge);
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	const config = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const compatibilityLevel = /^compatibility-level: (\S+)$/m.exec(config)?.[1];
	assert.ok(compatibilityLevel, `seed wrote no compatibility-level:\n${config}`);

	const bridgeOrigin = bareRepo("bridge-origin.git");
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, `seed bridge at compatibility level ${compatibilityLevel}`);
	runTool("git", ["remote", "add", "origin", bridgeOrigin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	const repoPath = join(bridge, "kb", `${repoId}.md`);
	write(
		repoPath,
		`---
kind: repo
id: ${repoId}
name: lifecycle-repo
gist: "Lifecycle implementation repo"
meta:
  path: workspace/lifecycle-repo
  trunk: main
  remotes:
    cloud: ${cloud.replaceAll("\\", "/")}
    local: ${local.replaceAll("\\", "/")}
---
`,
	);
	const pitched = run(["pitch", "Exercise a complete lifecycle.", "--name", "lifecycle"], bridge);
	assertOk(pitched, "pitch failed");
	const featPath = join(bridge, /^Pitched (.+)$/m.exec(pitched.stdout)?.[1] ?? "");
	const featText = readFileSync(featPath, "utf8");
	const featId = /^id: (\S+)$/m.exec(featText)?.[1];
	assert.ok(featId, `pitched feat has no id:\n${featText}`);
	write(featPath, featText.replace(/^---$/m, `---\nscopes:\n  - ${repoId}`));
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "scope lifecycle feat");
	runTool("git", ["push"], bridge);

	assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate repo failed");
	const first = run(["record.dive", "--feat", featId, "--diver", diver], bridge);
	assertOk(first, "first record.dive failed");
	const firstId = recordedId(first.stdout);
	assertOk(
		run(["record.dive", "--ref", firstId, "--brief", "Test packing and reclaiming."], bridge),
		"first brief failed",
	);
	assertOk(run(["jump"], bridge), "first jump failed");
	const worktree = join(bridge, "workspace", "lifecycle-repo");
	write(join(worktree, "packed.txt"), "packed work\n");
	runTool("git", ["add", "packed.txt"], worktree);
	gitCommit(worktree, "add packed work");
	assertOk(run(["pack"], bridge), "pack failed");

	const firstPath = join(bridge, "kb", `${firstId}.md`);
	const packed = readFileSync(firstPath, "utf8");
	assert.doesNotMatch(packed, /^  diver: (?!null$).+$/m, "packed dive should be claimable");
	assert.match(packed, /rel: patch/, "packed dive should carry a patch chain");
	assertOk(run(["record.dive", "--ref", firstId, "--diver", diver], bridge), "reclaim failed");
	write(
		join(bridge, "kb", `${diveGateId}.md`),
		`---
kind: assertion
id: ${diveGateId}
name: lifecycle-dive-gate
gist: "Run the lifecycle dive gate"
meta:
  test-script: kb/artifacts/lifecycle-dive-gate.mjs
---
`,
	);
	write(
		join(bridge, "kb", "artifacts", "lifecycle-dive-gate.mjs"),
		'export function run() { console.log("lifecycle dive gate ran"); }\n',
	);
	write(
		join(bridge, "kb", `${featGateId}.md`),
		`---
kind: assertion
id: ${featGateId}
name: lifecycle-feat-gate
gist: "Run the lifecycle feat gate"
meta:
  test-script: kb/artifacts/lifecycle-feat-gate.mjs
---
`,
	);
	write(
		join(bridge, "kb", "artifacts", "lifecycle-feat-gate.mjs"),
		'export function run() { console.log("lifecycle feat gate ran"); }\n',
	);
	write(
		firstPath,
		readFileSync(firstPath, "utf8").replace(
			/^links:\n/m,
			`links:\n  - kb/${diveGateId}.md:\n      rel: test.gate\n`,
		),
	);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			/^links:\n/m,
			`links:\n  - kb/${featGateId}.md:\n      rel: test.gate\n`,
		),
	);
	const diveTests = run(["test"], bridge);
	assertOk(diveTests, "dive-scoped test failed");
	assert.match(diveTests.stdout, /lifecycle dive gate ran/);
	assert.doesNotMatch(diveTests.stdout, /lifecycle feat gate ran/);
	const fullTests = run(["test", "--full"], bridge);
	assertOk(fullTests, "full test failed");
	assert.match(fullTests.stdout, /lifecycle dive gate ran/);
	assert.match(fullTests.stdout, /lifecycle feat gate ran/);
	/**
	 * The feat's gate is broken here rather than the dive's, because the dive
	 * already links its own gate as `test.gate` -- asserting that link would
	 * pass whether or not anything attached it. The feat's gate is one this dive
	 * has never named, so the link can only be there because the failure put it
	 * there.
	 */
	write(
		join(bridge, "kb", "artifacts", "lifecycle-feat-gate.mjs"),
		'export function run() { console.error("lifecycle feat gate failed"); return false; }\n',
	);
	const failedTests = run(["test", "--full"], bridge);
	assert.equal(failedTests.status, 1, "the failing feat gate must fail test --full");
	const testedDive = readFileSync(firstPath, "utf8");
	assert.match(testedDive, /^## Test report \d{4}-\d{2}-\d{2}T.*Z$/m);
	assert.match(testedDive, new RegExp(`kb/${featGateId}\\.md:\\n      rel: test\\.gate`));
	assertOk(run(["jump"], bridge), "reclaim jump failed");
	assertOk(run(["bail", "--reason", "exercise the bail path"], bridge), "bail failed");
	const bailed = readFileSync(firstPath, "utf8");
	assert.match(bailed, /^kind: memo$/m);
	assert.match(bailed, /^## Bail report\b/m);

	const second = run(["record.dive", "--feat", featId, "--diver", diver], bridge);
	assertOk(second, "second record.dive failed");
	const secondId = recordedId(second.stdout);
	const noDiveGates = run(["test"], bridge);
	assert.notEqual(noDiveGates.status, 0, "a dive with no test gates must not pass");
	assert.match(noDiveGates.stderr, /--full/);
	assertOk(
		run(["record.dive", "--ref", secondId, "--brief", "Test landing and publication."], bridge),
		"second brief failed",
	);
	assertOk(run(["jump"], bridge), "second jump failed");
	write(join(worktree, "landed.txt"), "landed work\n");
	runTool("git", ["add", "landed.txt"], worktree);
	gitCommit(worktree, "add landed work");
	assertOk(run(["land"], bridge), "land failed");

	const landed = readFileSync(join(bridge, "kb", `${secondId}.md`), "utf8");
	assert.match(landed, /^kind: memo$/m);
	assert.match(landed, /^## Outcome$/m);
	const published = runTool(
		"git",
		["show-ref", "--verify", "--hash", "refs/heads/work/lifecycle"],
		cloud,
	).stdout.trim();
	assert.match(published, /^[0-9a-f]{40}$/, "land should publish the work branch to cloud");
});
