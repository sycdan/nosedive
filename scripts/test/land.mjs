import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	gitCommitEmpty,
	packageVersionPattern,
	run,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("land");
const repoId = "019fd470-0000-7000-8000-000000000001";
const effortId = "019fd470-0000-7000-8000-000000000002";

function setup(name, repoMeta = "") {
	const source = join(tmp, `${name}-source`);
	const bridge = join(tmp, name);
	const origin = join(tmp, `${name}-origin.git`);
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, "base");

	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Nosedive Test"], bridge);
	runTool("git", ["config", "user.email", "nosedive@example.invalid"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: ${name}-repo
gist: "Land test repo"
meta:
  path: workspace/${name}-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
${repoMeta}---
`,
	);
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: effort
id: ${effortId}
name: land-test.nosedive
gist: "Land test effort"
scopes:
  - ${repoId}
---
`,
	);
	runTool("git", ["add", "--", "kb", ".nosedive"], bridge);
	gitCommit(bridge, "initial bridge state");
	mkdirSync(origin, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], origin);
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);
	assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate failed");
	const dive = run(
		["record.dive", "--effort", effortId, "--diver", "nosedive@example.invalid"],
		bridge,
	);
	assertOk(dive, "record.dive failed");
	const diveId = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(dive.stdout)?.[1];
	assert.ok(diveId, `record.dive did not report a dive id:\n${dive.stdout}`);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "record dive");
	return { bridge, worktree: join(bridge, "workspace", `${name}-repo`), diveId };
}

test("land commits effort and nosedive provenance", () => {
	const { bridge } = setup("provenance");
	const result = run(["land"], bridge);
	assertOk(result, "land failed");
	const commitBody = runTool("git", ["log", "-1", "--format=%B"], bridge).stdout;
	assert.match(commitBody, new RegExp(`Effort: ${effortId}`));
	assert.match(
		commitBody,
		new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern} <noreply@nosedive\\.dev>`),
	);
	assert.equal((commitBody.match(/Co-Authored-By: nosedive/g) ?? []).length, 1);
});

test("land refuses a read-only scope that has commits past its pin", () => {
	const { bridge, worktree, diveId } = setup("readonly");
	gitCommitEmpty(worktree, "read-only work");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	const diveText = readFileSync(divePath, "utf8");
	write(divePath, diveText.replace("mode: rw", "mode: ro"));
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land unexpectedly accepted read-only commits");
	assert.match(result.stderr, new RegExp(`read-only scope ${repoId} is ahead of pinned ref`));
	assert.match(result.stderr, /[0-9a-f]{7,}/, "refusal should name the ahead commit");
});
