import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, run, runTool, write, writeBridgeConfig } from "../test-helpers.mjs";

const tmp = createTmp("scan");

test("scan resolves, hydrates, and prints the documentation-only load brief", () => {
	const bridge = join(tmp, "bridge");
	const repoId = "019fd7c4-0000-7000-8000-000000000001";
	const source = join(bridge, "repos", "source");
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	runTool("git", ["config", "user.name", "Scan Test"], source);
	runTool("git", ["config", "user.email", "scan@example.test"], source);
	write(join(source, "README.md"), "# Source\n");
	runTool("git", ["add", "README.md"], source);
	runTool("git", ["commit", "-m", "initial"], source);
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	writeBridgeConfig(bridge);
	write(
		join(bridge, "kb", "repo.md"),
		`---\nkind: repo\nid: ${repoId}\nname: scan-fixture\ngist: "Scan fixture"\nmeta:\n  path: workspace/scan-fixture\n  remotes:\n    local: repos/source\n---\n\n# Repo\n`,
	);

	const result = run(["scan", "--repo", "scan-fixture"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`created repo=${repoId}`));
	assert.equal(existsSync(join(bridge, "workspace", "scan-fixture", ".git")), true);
	assert.match(result.stdout, /Repo doc: kb\/repo\.md/);
	assert.match(
		result.stdout,
		/Read README files, contributing guides, docs\/, hooks, and CI configuration\. Do not inspect source code\./,
	);
	assert.match(result.stdout, /quality gates and local conventions/);
	assert.match(result.stdout, /one meaningfully named kind: load doc/);
	assert.match(
		result.stdout,
		/update the matching documented workload's existing kind: load doc in place/,
	);

	const missing = run(["scan"], bridge);
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /requires exactly one --repo/);
	const deep = run(["scan", "--repo", repoId, "--deep"], bridge);
	assert.notEqual(deep.status, 0);
	assert.match(deep.stderr, /--deep is not implemented/);
});
