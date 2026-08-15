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
	assertOk(run(["jump"], bridge), "reclaim jump failed");
	assertOk(run(["bail", "--reason", "exercise the bail path"], bridge), "bail failed");
	const bailed = readFileSync(firstPath, "utf8");
	assert.match(bailed, /^kind: memo$/m);
	assert.match(bailed, /^## Bail report\b/m);

	const second = run(["record.dive", "--feat", featId, "--diver", diver], bridge);
	assertOk(second, "second record.dive failed");
	const secondId = recordedId(second.stdout);
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
