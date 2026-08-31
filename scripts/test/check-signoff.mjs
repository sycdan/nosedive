import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createTmp, runTool, write } from "../test-helpers.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "check-signoff.mjs");
const identity = ["-c", "user.name=Test Author", "-c", "user.email=test@example.com"];
const tmp = createTmp("check-signoff");

function repoAt(name) {
	const repo = join(tmp, name);
	mkdirSync(repo, { recursive: true });
	runTool("git", ["init", "-b", "main"], repo);
	return repo;
}

function commit(repo, name, extra = []) {
	write(join(repo, name), `${name}\n`);
	runTool("git", ["add", name], repo);
	runTool("git", [...identity, "commit", ...extra, "-m", name], repo);
	return runTool("git", ["rev-parse", "HEAD"], repo).stdout.trim();
}

function check(repo, args) {
	return spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });
}

test("a range passes only when every commit carries the trailer", () => {
	const repo = repoAt("range");
	const base = commit(repo, "base.txt");
	commit(repo, "certified.txt", ["-s"]);
	assert.equal(check(repo, [`${base}..HEAD`]).status, 0);

	const unsigned = commit(repo, "unsigned.txt");
	const rejection = check(repo, [`${base}..HEAD`]);
	assert.equal(rejection.status, 1);
	assert.match(rejection.stderr, /no Signed-off-by trailer: \w+ unsigned\.txt/);
	assert.match(rejection.stderr, /git rebase --signoff/);
	assert.doesNotMatch(rejection.stderr, /certified/, "a signed commit must not be reported");
	assert.equal(check(repo, [`${unsigned}..HEAD`]).status, 0, "an empty range has nothing to fail");
});

test("with no range, only commits no remote holds are checked", () => {
	const repo = repoAt("remotes");
	const pushed = commit(repo, "history.txt");
	// The state a fetched clone is in. Without it, every commit ever made looks new.
	runTool("git", ["update-ref", "refs/remotes/origin/main", pushed], repo);
	assert.equal(check(repo, []).status, 0, "history a remote already holds is not this push");

	commit(repo, "local.txt");
	assert.equal(check(repo, []).status, 1, "an unsigned commit no remote holds is refused");
});
