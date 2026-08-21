import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
	assertOk,
	createBridge,
	createNoBridge,
	createTmp,
	gitCommit,
	run,
	runTool,
	write,
} from "../test-helpers.mjs";

const tmp = createTmp("record-repo");
const noBridge = createNoBridge(tmp);

function backlogPath(bridge) {
	const config = readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8");
	const id = /^backlog: (\S+)$/m.exec(config)?.[1];
	assert.ok(id, "seeded bridge has no backlog id");
	return join(bridge, "kb", `${id}.md`);
}

function repoFiles(bridge) {
	return readdirSync(join(bridge, "kb"))
		.filter((filename) => filename.endsWith(".md"))
		.filter((filename) => /^kind: repo$/m.test(readFileSync(join(bridge, "kb", filename), "utf8")));
}

function sourceRepo(name) {
	const path = join(tmp, name);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "-b", "main"], path);
	write(join(path, "README.md"), `${name}\n`);
	runTool("git", ["add", "README.md"], path);
	gitCommit(path, `start ${name}`);
	return path;
}

function seededBridge(name) {
	const bridge = createBridge(tmp, name);
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	return bridge;
}

test("record.repo help is available without a bridge", () => {
	const help = run(["record.repo", "--help"], noBridge);
	assertOk(help, "record.repo --help failed");
	assert.match(
		help.stdout,
		/Usage: nosedive record\.repo <clone-url-or-local-path> \[--name <slug>\] \[--base-branch <branch>\]/,
	);
});

test("record.repo registers a local repository in backlog scopes", () => {
	const bridge = seededBridge("record-local");
	const source = sourceRepo("Alpha_Service");
	runTool(
		"git",
		["remote", "add", "origin", "https://example.invalid/team/Alpha_Service.git"],
		source,
	);

	const recorded = run(["record.repo", source], bridge);
	assertOk(recorded, "record.repo local path failed");
	assert.match(recorded.stdout, /Added alpha-service to backlog scopes/);
	assert.equal(repoFiles(bridge).length, 1);

	const repoPath = join(bridge, "kb", repoFiles(bridge)[0]);
	const repo = readFileSync(repoPath, "utf8");
	const repoId = /^id: (\S+)$/m.exec(repo)?.[1];
	assert.ok(repoId, "repo doc has no id");
	assert.match(repo, /^name: alpha-service$/m);
	assert.match(repo, /^  path: "workspace\/alpha-service"$/m);
	assert.match(repo, /^  trunk: "main"$/m);
	assert.match(repo, /^    cloud: "https:\/\/example\.invalid\/team\/Alpha_Service\.git"$/m);
	assert.match(repo, /^    local: /m);
	assert.match(readFileSync(backlogPath(bridge), "utf8"), new RegExp(`^  - ${repoId}$`, "m"));

	const backlogBeforeDuplicate = readFileSync(backlogPath(bridge), "utf8");
	const duplicate = run(["record.repo", source], bridge);
	assert.notEqual(duplicate.status, 0, "duplicate repository unexpectedly registered");
	assert.match(duplicate.stderr, /already registered/);
	assert.equal(repoFiles(bridge).length, 1, "duplicate left a second repo doc");
	assert.equal(
		readFileSync(backlogPath(bridge), "utf8"),
		backlogBeforeDuplicate,
		"duplicate changed the backlog",
	);
});

test("record.repo validates a clone URL and accepts explicit identity", () => {
	const bridge = seededBridge("record-url");
	const bare = join(tmp, "Remote.Project.git");
	runTool("git", ["clone", "--bare", sourceRepo("remote-project-source"), bare], tmp);
	const remote = pathToFileURL(bare).href;

	const recorded = run(
		["record.repo", remote, "--name", "api-service", "--base-branch", "main"],
		bridge,
	);
	assertOk(recorded, "record.repo clone URL failed");
	const repo = readFileSync(join(bridge, "kb", repoFiles(bridge)[0]), "utf8");
	assert.match(repo, /^name: api-service$/m);
	assert.match(
		repo,
		new RegExp(
			`^    cloud: ${JSON.stringify(remote).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
			"m",
		),
	);
	assert.doesNotMatch(repo, /^    local:/m);
});

test("record.repo refuses invalid input before writing either document", () => {
	const bridge = seededBridge("record-invalid");
	const backlogBefore = readFileSync(backlogPath(bridge), "utf8");
	const beforeFiles = readdirSync(join(bridge, "kb")).sort();

	const invalid = run(["record.repo", "missing-repository"], bridge);
	assert.notEqual(invalid.status, 0, "missing local repository unexpectedly registered");
	assert.match(invalid.stderr, /does not exist or is not a directory/);
	assert.deepEqual(readdirSync(join(bridge, "kb")).sort(), beforeFiles);
	assert.equal(readFileSync(backlogPath(bridge), "utf8"), backlogBefore);
});
