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

function repoDocPath(bridge, name) {
	for (const filename of repoFiles(bridge)) {
		const doc = readFileSync(join(bridge, "kb", filename), "utf8");
		if (new RegExp(`^name: ${name}$`, "m").test(doc)) return join(bridge, "kb", filename);
	}
	assert.fail(`repo doc ${name} not found`);
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
		/Usage: nosedive record\.repo \[<repo>\] \[--remote <clone-url-or-local-path>\] \[--url <page-url>\]/,
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
	assert.equal(repoFiles(bridge).length, 2);

	const repoPath = repoDocPath(bridge, "alpha-service");
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
	assert.equal(repoFiles(bridge).length, 2, "duplicate left a second repo doc");
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
	const repo = readFileSync(repoDocPath(bridge, "api-service"), "utf8");
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

test("record.repo commits the repo doc and the backlog it scoped", () => {
	const bridge = seededBridge("record-commit");
	const source = sourceRepo("Gamma_Service");
	const recorded = run(["record.repo", source], bridge);
	assertOk(recorded, "record.repo failed");
	assert.ok(recorded.stdout.includes("Committed repo(gamma-service): created"), recorded.stdout);

	const committed = runTool("git", ["show", "--pretty=format:", "--name-only", "HEAD"], bridge);
	const files = committed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	assert.equal(files.length, 2, `the repo doc and the backlog memo: ${committed.stdout}`);
});

test("a bare record.repo publishes a repo doc somebody edited by hand", () => {
	const bridge = seededBridge("record-bare-publish");
	assertOk(run(["record.repo", sourceRepo("Delta_Service")], bridge), "record.repo failed");
	const repoPath = repoDocPath(bridge, "delta-service");
	const repoId = /^id: (\S+)$/m.exec(readFileSync(repoPath, "utf8"))[1];
	write(repoPath, `${readFileSync(repoPath, "utf8")}\nNotes no command wrote.\n`);

	const published = run(["record.repo", repoId], bridge);
	assertOk(published, "a bare record.repo failed");
	assert.match(published.stdout, /Updated /);
	assert.match(
		runTool("git", ["show", `HEAD:kb/${repoId}.md`], bridge).stdout,
		/Notes no command wrote\./,
	);
	assert.equal(
		runTool("git", ["status", "--porcelain", "--", `kb/${repoId}.md`], bridge).stdout,
		"",
	);
});

// `--url` named the clone source before this level and names the repository
// page after it, so the two meanings are pinned separately: what a call written
// before the rename still does, and what the new spelling writes.

test("--remote takes the clone source and --url writes meta.url", () => {
	const bridge = seededBridge("record-remote-and-page");
	const source = sourceRepo("Epsilon_Service");

	const recorded = run(
		["record.repo", "--remote", source, "--url", "https://example.invalid/team/epsilon"],
		bridge,
	);
	assertOk(recorded, "record.repo --remote --url failed");
	assert.match(recorded.stdout, /Added epsilon-service to backlog scopes/);

	const repo = readFileSync(repoDocPath(bridge, "epsilon-service"), "utf8");
	assert.match(repo, /^  url: "https:\/\/example\.invalid\/team\/epsilon"$/m);
	assert.match(repo, /^    local: /m);
	// The page is a field of its own, never a second spelling of the remote.
	assert.doesNotMatch(repo, /^    cloud: "https:\/\/example\.invalid\/team\/epsilon"$/m);
	assert.equal(recorded.stderr.includes("--url"), false, recorded.stderr);
});

test("meta.url is absent, not empty, when no page is given", () => {
	const bridge = seededBridge("record-no-page");
	assertOk(run(["record.repo", "--remote", sourceRepo("Zeta_Service")], bridge), "record failed");
	assert.doesNotMatch(readFileSync(repoDocPath(bridge, "zeta-service"), "utf8"), /^  url:/m);
});

test("meta.url is never derived from an https clone URL", () => {
	const bridge = seededBridge("record-no-derive");
	const bare = join(tmp, "Derive.Project.git");
	runTool("git", ["clone", "--bare", sourceRepo("derive-project-source"), bare], tmp);

	const recorded = run(
		["record.repo", "--remote", pathToFileURL(bare).href, "--name", "derive-service"],
		bridge,
	);
	assertOk(recorded, "record.repo clone URL failed");
	assert.doesNotMatch(readFileSync(repoDocPath(bridge, "derive-service"), "utf8"), /^  url:/m);
});

test("a create with only --url reads it as the clone source and says so", () => {
	const bridge = seededBridge("record-url-retired");
	const source = sourceRepo("Eta_Service");

	const recorded = run(["record.repo", "--url", source], bridge);
	assertOk(recorded, "retired --url spelling failed");
	assert.match(recorded.stderr, /--url now records the human-facing repository page/);
	assert.match(recorded.stderr, /pass --remote instead/);

	const repo = readFileSync(repoDocPath(bridge, "eta-service"), "utf8");
	assert.match(repo, /^    local: /m, "the retired spelling stopped setting a remote");
	assert.doesNotMatch(repo, /^  url:/m, "the retired spelling wrote a page");
});

test("a create with no clone source names --remote", () => {
	const bridge = seededBridge("record-no-source");
	const refused = run(["record.repo", "--name", "orphan-service"], bridge);
	assert.notEqual(refused.status, 0, "a sourceless create unexpectedly succeeded");
	assert.match(refused.stderr, /requires --remote <clone-url-or-local-path>/);
});

test("--url refuses a value that cannot be a page and names --remote", () => {
	const bridge = seededBridge("record-page-not-a-page");
	const source = sourceRepo("Theta_Service");
	const beforeFiles = readdirSync(join(bridge, "kb")).sort();

	const refused = run(
		["record.repo", "--remote", source, "--url", "git@example.invalid:team/theta.git"],
		bridge,
	);
	assert.notEqual(refused.status, 0, "an ssh --url was unexpectedly accepted as a page");
	assert.match(refused.stderr, /must be an http\(s\) URL/);
	assert.match(refused.stderr, /Pass --remote <clone-url-or-local-path>/);
	assert.deepEqual(readdirSync(join(bridge, "kb")).sort(), beforeFiles);
});

test("a positional clone source leaves --url meaning the page", () => {
	const bridge = seededBridge("record-positional-and-page");
	const source = sourceRepo("Iota_Service");

	const recorded = run(
		["record.repo", source, "--url", "https://example.invalid/team/iota"],
		bridge,
	);
	assertOk(recorded, "positional source with --url page failed");
	assert.match(recorded.stderr, /the positional argument is deprecated -- pass --remote instead/);

	const repo = readFileSync(repoDocPath(bridge, "iota-service"), "utf8");
	assert.match(repo, /^  url: "https:\/\/example\.invalid\/team\/iota"$/m);
	assert.match(repo, /^    local: /m);
});

test("a patch reads --url as the page and --remote as the clone source", () => {
	const bridge = seededBridge("record-patch-page");
	const source = sourceRepo("Kappa_Service");
	assertOk(run(["record.repo", "--remote", source], bridge), "record.repo failed");
	const repoPath = repoDocPath(bridge, "kappa-service");
	const repoId = /^id: (\S+)$/m.exec(readFileSync(repoPath, "utf8"))[1];

	const paged = run(["record.repo", repoId, "--url", "https://example.invalid/team/kappa"], bridge);
	assertOk(paged, "patching meta.url failed");
	assert.match(paged.stdout, /Set meta\.url to https:\/\/example\.invalid\/team\/kappa/);
	assert.match(paged.stderr, /--url sets meta\.url/);
	assert.match(readFileSync(repoPath, "utf8"), /^  url: https:\/\/example\.invalid\/team\/kappa$/m);

	const remoted = run(
		["record.repo", repoId, "--remote", "https://example.invalid/team/kappa.git"],
		bridge,
	);
	assertOk(remoted, "patching the remote failed");
	assert.match(remoted.stdout, /Set meta\.remotes\.cloud/);
	const repo = readFileSync(repoPath, "utf8");
	assert.match(repo, /^    cloud: https:\/\/example\.invalid\/team\/kappa\.git$/m);
	assert.match(
		repo,
		/^  url: https:\/\/example\.invalid\/team\/kappa$/m,
		"the remote ate the page",
	);
});

test("a patch refuses --url that cannot be a page", () => {
	const bridge = seededBridge("record-patch-not-a-page");
	assertOk(run(["record.repo", "--remote", sourceRepo("Lambda_Service")], bridge), "record failed");
	const repoPath = repoDocPath(bridge, "lambda-service");
	const repoId = /^id: (\S+)$/m.exec(readFileSync(repoPath, "utf8"))[1];
	const before = readFileSync(repoPath, "utf8");

	const refused = run(
		["record.repo", repoId, "--url", "git@example.invalid:team/lambda.git"],
		bridge,
	);
	assert.notEqual(refused.status, 0, "an ssh --url was unexpectedly accepted on a patch");
	assert.match(refused.stderr, /Pass --remote <clone-url-or-local-path>/);
	assert.equal(readFileSync(repoPath, "utf8"), before, "a refused patch still wrote");
});
