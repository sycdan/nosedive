import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, libUrl, runTool, seededBridge } from "../test-helpers.mjs";

const { branchWorktree, helmBranchStatus, helmPorts, readNosediveRc } = await import(libUrl);
const tmp = createTmp("helm-branch");
const io = { log: () => {} };
const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

test("helm <branch> serves a published sibling worktree, reused after, and never a stranger's folder", () => {
	const { bridge, origin } = seededBridge(tmp, "branchy", "pilot@nosedive.invalid");

	const made = branchWorktree(bridge, "sandbox", "main", io);
	assert.equal(made, `${bridge}-sandbox`);
	assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], made), "sandbox");
	assert.equal(
		git(["rev-parse", "HEAD"], made),
		git(["rev-parse", "main"], origin),
		"starts at trunk",
	);
	assert.ok(
		git(["branch", "--list", "sandbox"], origin),
		"published, so dives there have an upstream",
	);
	assert.equal(git(["rev-parse", "--abbrev-ref", "@{u}"], made), "origin/sandbox");

	assert.equal(branchWorktree(bridge, "sandbox", "main", io), made, "reused");
	assert.equal(
		branchWorktree(bridge, "main", "main", io),
		bridge,
		"the bridge's own branch is served from it",
	);
	assert.equal(
		branchWorktree(made, "other", "main", io),
		`${bridge}-other`,
		"named after the bridge's own checkout, even from a worktree",
	);

	mkdirSync(`${bridge}-junk`);
	assert.throws(() => branchWorktree(bridge, "junk", "main", io), /not a worktree of this bridge/);
	assert.throws(() => branchWorktree(bridge, "a..b", "main", io), /not a branch name/);

	// Each worktree gets ports of its own; the bridge keeps its own.
	const bridgePorts = helmPorts(readNosediveRc(bridge));
	assert.notEqual(helmPorts(readNosediveRc(made))[0], bridgePorts[0]);
	assert.notEqual(
		helmPorts(readNosediveRc(made))[0],
		helmPorts(readNosediveRc(`${bridge}-other`))[0],
	);

	assert.deepEqual(helmBranchStatus(made, "main"), {
		name: "sandbox",
		trunk: "main",
		ahead: 0,
		behind: 0,
	});
	writeFileSync(join(made, "note.md"), "on the branch\n");
	runTool("git", ["add", "note.md"], made);
	runTool("git", ["commit", "-m", "branch work"], made);
	assert.equal(helmBranchStatus(made, "main").ahead, 1);
	assert.ok(
		existsSync(join(made, ".nosedive", "config.yaml")),
		"the worktree is a bridge of its own",
	);
});
