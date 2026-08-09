import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const tmp = createTmp("record-dive");
const repoId = "019fc623-0000-7000-8000-000000000001";
const effortId = "019fc623-0000-7000-8000-000000000002";
const unhydratedRepoId = "019fc623-0000-7000-8000-000000000003";
const unrelatedRepoId = "019fc623-0000-7000-8000-000000000004";
const backlogId = "019fc623-0000-7000-8000-000000000005";

function createRepo(path, id) {
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "-b", "main"], path);
	write(join(path, "README.md"), "base\n");
	runTool("git", ["add", "."], path);
	gitCommit(path, "base");
	write(join(path, ".nosedive-ref"), `id: ${id}\n`);
	return runTool("git", ["rev-parse", "main"], path).stdout.trim();
}

function writeRepoDoc(bridge, id, name, path, local = path) {
	write(
		join(bridge, "kb", `${id}.md`),
		`---
kind: repo
id: ${id}
name: ${name}
gist: "Test repo"
meta:
  path: ${path}
  trunk: main
  remotes:
    local: ${local}
---
`,
	);
}

function setup(name) {
	const bridge = createBridge(tmp, name);
	const repo = join(bridge, "workspace", "repo");
	const repoCommit = createRepo(repo, repoId);
	writeRepoDoc(bridge, repoId, "repo", "workspace/repo");
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: record-dive.nosedive
gist: "Record dives"
scopes:
  - ${repoId}
---

# Record Dive
`,
	);
	return { bridge, repo, repoCommit };
}

/** A bridge whose configured backlog memo scopes the fixture repo, for `--free`. */
function setupFree(name, { scopeRepo = true } = {}) {
	const bridge = createBridge(tmp, name, { backlog: backlogId });
	const repo = join(bridge, "workspace", "repo");
	const repoCommit = createRepo(repo, repoId);
	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: repo
gist: "Test repo"
meta:
  path: workspace/repo
  trunk: main
  default-mode: rw
  remotes:
    local: workspace/repo
---
`,
	);
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---
kind: memo
id: ${backlogId}
name: "backlog.test"
gist: "Test backlog."
${scopeRepo ? `scopes:\n  - ${repoId}\n` : ""}---

# Backlog
`,
	);
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: record-dive.nosedive
gist: "Record dives"
scopes:
  - ${repoId}
---

# Record Dive
`,
	);
	return { bridge, repoCommit };
}

function recordedPath(bridge, stdout) {
	const match = /^Recorded (.+)$/m.exec(stdout);
	assert.ok(match, `record.dive did not report a document:\n${stdout}`);
	return join(bridge, match[1]);
}

test("record.dive defaults to the effort's cached default-branch repositories", () => {
	const { bridge, repoCommit } = setup("create");
	const unhydratedSource = join(bridge, "sources", "unhydrated");
	const unhydratedCommit = createRepo(unhydratedSource, unhydratedRepoId);
	writeRepoDoc(
		bridge,
		unhydratedRepoId,
		"unhydrated",
		"workspace/unhydrated",
		"sources/unhydrated",
	);
	const unrelated = join(bridge, "workspace", "unrelated");
	createRepo(unrelated, unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "unrelated", "workspace/unrelated");
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: record-dive.nosedive
gist: "Record dives"
scopes:
  - ${repoId}
  - ${unhydratedRepoId}
---

# Record Dive
`,
	);
	const result = run(["record.dive", "--effort", effortId], bridge);
	assertOk(result, "record.dive create failed");
	const doc = readFileSync(recordedPath(bridge, result.stdout), "utf8");
	assert.match(doc, /^kind: dive$/m);
	assert.match(doc, /^name: record-dive\.nosedive\.[0-9a-f]{6}$/m);
	assert.match(doc, /^gist: "Working on Record Dive\."$/m);
	assert.match(doc, new RegExp(`^  effort: ${effortId}$`, "m"));
	assert.match(doc, new RegExp(`^  - ${repoId}:\n      ref: ${repoCommit}\n      mode: rw$`, "m"));
	assert.match(
		doc,
		new RegExp(`^  - ${unhydratedRepoId}:\n      ref: ${unhydratedCommit}\n      mode: rw$`, "m"),
	);
	assert.doesNotMatch(doc, new RegExp(`^  - ${unrelatedRepoId}:`, "m"));
	assert.match(doc, /^# Dive Record$/m);
	assert.match(doc, /^id: [0-9a-f-]+$/m);
});

test("record.dive patches only provided fields and can resolve its marker", () => {
	const { bridge } = setup("patch");
	const created = run(
		["record.dive", "--effort", effortId, "--gist", "Initial.", "--brief", "Keep this."],
		bridge,
	);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const marker = join(bridge, "workspace", ".nosedive-ref");
	writeFileSync(marker, `id: ${id}\n`);
	const updated = run(
		["record.dive", "--ref", "workspace/.nosedive-ref", "--title", "Updated"],
		bridge,
	);
	assertOk(updated, "record.dive update failed");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, /^gist: "Initial\."$/m);
	assert.match(doc, /^# Updated$/m);
	assert.match(doc, /## Brief\n\nKeep this\./);
});

test("record.dive validates mutation modes", () => {
	const { bridge } = setup("validation");
	const missingEffort = run(["record.dive"], bridge, "");
	assert.notEqual(missingEffort.status, 0);
	assert.match(missingEffort.stderr, /requires --effort/);
	const conflictingScopes = run(
		["record.dive", "--effort", effortId, "--scope", repoId, "--clear-scopes"],
		bridge,
		"",
	);
	assert.notEqual(conflictingScopes.status, 0);
	assert.match(conflictingScopes.stderr, /cannot be combined/);
	const created = run(["record.dive", "--effort", effortId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// An unbriefed dive can still be briefed; a briefed one is write-once.
	assertOk(
		run(["record.dive", "--ref", id, "--brief", "First brief."], bridge),
		"record.dive brief-on-update failed",
	);
	assert.match(readFileSync(path, "utf8"), /## Brief\n\nFirst brief\./);
	const rebrief = run(["record.dive", "--ref", id, "--brief", "Second brief."], bridge, "");
	assert.notEqual(rebrief.status, 0);
	assert.match(rebrief.stderr, /already has a brief/);
	const emptyBrief = run(["record.dive", "--effort", effortId, "--brief", "  "], bridge, "");
	assert.notEqual(emptyBrief.status, 0);
	assert.match(emptyBrief.stderr, /brief cannot be empty/);
});

test("record.dive activates only for the pilot diver", () => {
	const { bridge } = setup("activation");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const other = run(["record.dive", "--effort", effortId, "--diver", "other@example.test"], bridge);
	assertOk(other, "record.dive with another diver failed");
	assert.equal(existsSync(join(bridge, "workspace", ".nosedive-ref")), false);
	const pilot = run(["record.dive", "--effort", effortId, "--diver", "pilot@example.test"], bridge);
	assertOk(pilot, "record.dive with pilot diver failed");
	assert.match(readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"), /^id: /);
});

test("record.dive requires --takeover to replace a held diver", () => {
	const { bridge } = setup("ownership");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(
		["record.dive", "--effort", effortId, "--diver", "owner@example.test"],
		bridge,
	);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const replacement = run(["record.dive", "--ref", id, "--diver", "other@example.test"], bridge);
	assert.notEqual(replacement.status, 0);
	assert.match(replacement.stderr, /held by owner@example\.test/);
	assert.match(replacement.stderr, /--takeover/);
	assertOk(run(["record.dive", "--ref", id, "--takeover"], bridge), "takeover failed");
	// The takeover writes the running pilot's own email, never the one on the
	// command line: there is no --diver to disagree with.
	assert.match(readFileSync(path, "utf8"), /^  diver: "?pilot@example\.test"?$/m);
});

test("record.dive refuses --takeover on a dive nobody holds", () => {
	const { bridge } = setup("takeover-unheld");
	const created = run(["record.dive", "--effort", effortId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const taken = run(["record.dive", "--ref", id, "--takeover"], bridge);
	assert.notEqual(taken.status, 0);
	assert.match(taken.stderr, /not held/);
});

test("record.dive links a claimed dive as working", () => {
	const { bridge } = setup("working-link");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(
		["record.dive", "--effort", effortId, "--diver", "pilot@example.test"],
		bridge,
	);
	assertOk(created, "record.dive create failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	const effort = readFileSync(join(bridge, "kb", `${effortId}.md`), "utf8");
	assert.match(effort, new RegExp(`- kb/${id}\\.md:\n      rel: working`));
});

test("record.dive --free records an empty dive scoping the backlog read-only", () => {
	const { bridge, repoCommit } = setupFree("free");
	const result = run(["record.dive", "--free"], bridge);
	assertOk(result, "record.dive --free failed");
	const path = recordedPath(bridge, result.stdout);
	const doc = readFileSync(path, "utf8");
	const id = /^id: (.+)$/m.exec(doc)[1];
	assert.match(doc, /^kind: dive$/m);
	// The id stands in for the name a free dive has not been given yet.
	assert.match(doc, new RegExp(`^name: ${id}$`, "m"));
	// ro despite the repo doc's default-mode: rw -- nothing about an unbriefed,
	// unclaimed dive justifies a writable checkout.
	assert.match(doc, new RegExp(`^  - ${repoId}:\n      ref: ${repoCommit}\n      mode: ro$`, "m"));
	assert.doesNotMatch(doc, /^gist:/m);
	assert.doesNotMatch(doc, /^meta:/m);
	assert.doesNotMatch(doc, /^links:/m);
	assert.doesNotMatch(doc, /^# /m);
	assert.equal(existsSync(join(bridge, "workspace", ".nosedive-ref")), false);
	// The agent that just made the dive is the one that has to fill it in, so it
	// is told what is missing without having to run preflight to find out.
	assert.match(
		result.stdout,
		/^needs: needs-name, needs-gist, needs-brief, needs-diver, never-jumped, local-only$/m,
	);
});

test("record.dive --free warns when the backlog scopes no repos", () => {
	const { bridge } = setupFree("free-empty", { scopeRepo: false });
	const result = run(["record.dive", "--free"], bridge);
	assertOk(result, "record.dive --free failed");
	assert.match(result.stderr, /scopes no repos/);
	assert.match(readFileSync(recordedPath(bridge, result.stdout), "utf8"), /^scopes: \[\]$/m);
});

test("record.dive --free takes no other option", () => {
	const { bridge } = setupFree("free-exclusive");
	const created = run(["record.dive", "--effort", effortId], bridge);
	assertOk(created, "record.dive create failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	for (const extra of [
		["--effort", effortId],
		["--ref", id],
		["--diver", "pilot@example.test"],
		["--scope", repoId],
		["--clear-scopes"],
		["--takeover"],
	]) {
		const result = run(["record.dive", "--free", ...extra], bridge, "");
		assert.notEqual(result.status, 0, `--free ${extra.join(" ")} unexpectedly succeeded`);
		assert.match(result.stderr, /--free cannot be combined with any other option/);
	}
});

test("record.dive --free ignores the active dive", () => {
	const { bridge } = setupFree("free-active");
	const created = run(["record.dive", "--effort", effortId], bridge);
	assertOk(created, "record.dive create failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	const marker = join(bridge, "workspace", ".nosedive-ref");
	writeFileSync(marker, `id: ${id}\n`);
	assertOk(run(["record.dive", "--free"], bridge), "record.dive --free failed");
	assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${id}\\n$`));
});

test("record.dive reassigns its reciprocal effort link", () => {
	const { bridge } = setup("patch-meta");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--effort", effortId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const marker = join(bridge, "workspace", ".nosedive-ref");
	writeFileSync(marker, `id: ${id}\n`);
	const effort = "019fc623-0000-7000-8000-000000000003";
	write(
		join(bridge, "kb", `${effort}.md`),
		`---
kind: feat
id: ${effort}
name: updated-effort
gist: "Updated effort"
---

# Updated Effort
`,
	);
	const updated = run(
		["record.dive", "--ref", id, "--effort", effort, "--diver", "pilot@example.test"],
		bridge,
	);
	assertOk(updated, "record.dive meta update failed");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, new RegExp(`^  effort: ${effort}$`, "m"));
	assert.match(doc, /^  diver: pilot@example\.test$/m);
	assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${id}\\n$`));
	const oldEffort = readFileSync(join(bridge, "kb", `${effortId}.md`), "utf8");
	const newEffort = readFileSync(join(bridge, "kb", `${effort}.md`), "utf8");
	assert.doesNotMatch(oldEffort, new RegExp(`kb/${id}\\.md`));
	assert.equal((newEffort.match(new RegExp(`kb/${id}\\.md`, "g")) ?? []).length, 1);
	assert.match(newEffort, new RegExp(`- kb/${id}\\.md:\n      rel: working`));
});
