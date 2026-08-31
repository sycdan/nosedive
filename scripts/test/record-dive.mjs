import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const featId = "019fc623-0000-7000-8000-000000000002";
const unhydratedRepoId = "019fc623-0000-7000-8000-000000000003";
const unrelatedRepoId = "019fc623-0000-7000-8000-000000000004";
const backlogId = "019fc623-0000-7000-8000-000000000005";
const testDiver = "01a05527-a49a-714c-9d35-3fa310ac6270@nosedive.invalid";

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
		join(bridge, "kb", `${featId}.md`),
		`---
kind: feat
id: ${featId}
name: record-dive.nosedive
gist: "Record dives"
scopes:
  - ${repoId}:
      work-branch: work/record-dive.nosedive
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
		join(bridge, "kb", `${featId}.md`),
		`---
kind: feat
id: ${featId}
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

test("record.dive defaults to the feat's cached default-branch repositories", () => {
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
		join(bridge, "kb", `${featId}.md`),
		`---
kind: feat
id: ${featId}
name: record-dive.nosedive
gist: "Record dives"
scopes:
  - ${repoId}:
      work-branch: work/record-dive.nosedive
  - ${unhydratedRepoId}:
      work-branch: work/record-dive.nosedive
---

# Record Dive
`,
	);
	const result = run(["record.dive", "--effort", featId], bridge);
	assertOk(result, "record.dive create failed");
	const doc = readFileSync(recordedPath(bridge, result.stdout), "utf8");
	assert.match(doc, /^kind: dive$/m);
	assert.match(doc, /^name: record-dive\.nosedive\.[0-9a-f]{6}$/m);
	assert.match(doc, /^gist: "Working on Record Dive\."$/m);
	assert.match(doc, new RegExp(`^  feat: ${featId}$`, "m"));
	assert.doesNotMatch(doc, /^  effort: /m, "the dead spelling is never written");
	assert.match(
		doc,
		new RegExp(
			`^  - ${repoId}:\n      ref: ${repoCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
	assert.match(
		doc,
		new RegExp(
			`^  - ${unhydratedRepoId}:\n      ref: ${unhydratedCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
	assert.doesNotMatch(doc, new RegExp(`^  - ${unrelatedRepoId}:`, "m"));
	assert.match(doc, /^# Dive Record$/m);
	assert.match(doc, /^id: [0-9a-f-]+$/m);
});

test("record.dive accepts --feat as the canonical create flag", () => {
	const { bridge, repoCommit } = setup("create-feat");
	const result = run(["record.dive", "--feat", featId], bridge);
	assertOk(result, "record.dive create with --feat failed");
	const doc = readFileSync(recordedPath(bridge, result.stdout), "utf8");
	assert.match(doc, /^kind: dive$/m);
	assert.match(doc, /^name: record-dive\.nosedive\.[0-9a-f]{6}$/m);
	assert.match(doc, new RegExp(`^  feat: ${featId}$`, "m"));
	assert.match(
		doc,
		new RegExp(
			`^  - ${repoId}:\n      ref: ${repoCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
	const id = /^id: (\S+)$/m.exec(doc)[1];
	assert.match(result.stdout, /^Next steps:$/m);
	assert.match(
		result.stdout,
		new RegExp(`^nosedive jump kb/${id}\\.md$`, "m"),
		"record.dive should end by naming jump on the new dive",
	);
});

test("record.dive accepts --effort as a compatibility alias", () => {
	const { bridge } = setup("create-effort-alias");
	const result = run(["record.dive", "--effort", featId], bridge);
	assertOk(result, "record.dive create with --effort alias failed");
	assert.match(readFileSync(recordedPath(bridge, result.stdout), "utf8"), /^kind: dive$/m);
});

test("record.dive accepts matching --feat and --effort refs", () => {
	const { bridge } = setup("create-matching-feat-effort");
	const result = run(["record.dive", "--feat", featId, "--effort", featId], bridge);
	assertOk(result, "record.dive create with matching --feat and --effort failed");
	assert.match(
		readFileSync(recordedPath(bridge, result.stdout), "utf8"),
		new RegExp(`^  feat: ${featId}$`, "m"),
	);
});

test("record.dive patches only provided fields and can resolve its marker", () => {
	const { bridge } = setup("patch");
	const created = run(
		["record.dive", "--effort", featId, "--gist", "Initial.", "--brief", "Keep this."],
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

test("record.dive patches the owning feat with --feat", () => {
	const { bridge } = setup("patch-feat");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const feat = "019fc623-0000-7000-8000-000000000008";
	write(
		join(bridge, "kb", `${feat}.md`),
		`---
kind: feat
id: ${feat}
name: updated-feat
gist: "Updated feat"
---

# Updated Feat
`,
	);
	const updated = run(["record.dive", "--ref", id, "--feat", feat], bridge);
	assertOk(updated, "record.dive patch with --feat failed");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, new RegExp(`^name: updated-feat\\.[0-9a-f]{6}$`, "m"));
	assert.match(doc, new RegExp(`^  feat: ${feat}$`, "m"));
});

test("record.dive refuses mismatched --feat and --effort without writing", () => {
	const { bridge } = setup("conflicting-feat-effort");
	const beforeDocs = readdirSync(join(bridge, "kb"))
		.filter((name) => name.endsWith(".md"))
		.sort();
	const result = run(
		["record.dive", "--feat", featId, "--effort", "019fc623-0000-7000-8000-000000000099"],
		bridge,
		"",
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--feat/);
	assert.match(result.stderr, /--effort/);
	assert.deepEqual(
		readdirSync(join(bridge, "kb"))
			.filter((name) => name.endsWith(".md"))
			.sort(),
		beforeDocs,
	);
});

test("record.dive validates mutation modes", () => {
	const { bridge } = setup("validation");
	const missingEffort = run(["record.dive"], bridge, "");
	assert.notEqual(missingEffort.status, 0);
	assert.match(missingEffort.stderr, /requires --feat or --effort/);
	// `--clear-scopes` with an upscope is how a dive replaces its scope set rather
	// than adding to it, so the two are no longer in conflict.
	const replaced = run(
		["record.dive", "--effort", featId, "--upscope", repoId, "--clear-scopes"],
		bridge,
	);
	assertOk(replaced, "clearing then scoping should be accepted");
	const created = run(["record.dive", "--effort", featId], bridge);
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
	const emptyBrief = run(["record.dive", "--effort", featId, "--brief", "  "], bridge, "");
	assert.notEqual(emptyBrief.status, 0);
	assert.match(emptyBrief.stderr, /brief cannot be empty/);
});

test("record.dive activates only for the pilot diver", () => {
	const { bridge } = setup("activation");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const other = run(["record.dive", "--effort", featId, "--diver", "other@example.test"], bridge);
	assertOk(other, "record.dive with another diver failed");
	assert.equal(existsSync(join(bridge, "workspace", ".nosedive-ref")), false);
	const pilot = run(["record.dive", "--effort", featId, "--diver", "pilot@example.test"], bridge);
	assertOk(pilot, "record.dive with pilot diver failed");
	assert.match(readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"), /^id: /);
});

test("record.dive records for others while a dive is active, and claims for nobody else", () => {
	const { bridge } = setup("record-while-active");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const held = run(["record.dive", "--effort", featId, "--diver", "pilot@example.test"], bridge);
	assertOk(held, "record.dive create failed");
	const marker = join(bridge, "workspace", ".nosedive-ref");
	const activeId = /^id: (.+)$/m.exec(readFileSync(marker, "utf8"))[1];

	// Writing up work for the backlog touches no marker, so the dive the
	// workspace holds has no bearing on it.
	for (const extra of [[], ["--diver", "other@example.test"]]) {
		const recorded = run(["record.dive", "--effort", featId, ...extra], bridge);
		assertOk(recorded, `record.dive ${extra.join(" ")} refused while a dive was active`);
		assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${activeId}\\n$`));
	}

	// Claiming is the part that cannot happen twice.
	const claimed = run(
		["record.dive", "--effort", featId, "--diver", "pilot@example.test"],
		bridge,
		"",
	);
	assert.notEqual(claimed.status, 0);
	assert.match(claimed.stderr, new RegExp(`pilot already has active dive ${activeId}`));
	assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${activeId}\\n$`));
});

test("record.dive requires --takeover to replace a held diver", () => {
	const { bridge } = setup("ownership");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--effort", featId, "--diver", "owner@example.test"], bridge);
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
	const created = run(["record.dive", "--effort", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const taken = run(["record.dive", "--ref", id, "--takeover"], bridge);
	assert.notEqual(taken.status, 0);
	assert.match(taken.stderr, /not held/);
});

/**
 * `pack` puts down the dive the workspace is on. `--packer` is the same release
 * reached from outside that workspace, for a dive recorded somewhere else, so
 * the two agree on what a released dive looks like: diver null, packer set.
 */
test("record.dive --packer releases a dive the pilot holds", () => {
	const { bridge } = setup("packer");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	assertOk(run(["record.dive", "--ref", id, "--diver", "pilot@example.test"], bridge), "claim");
	// Claiming activated it; `--packer` is for a dive recorded elsewhere, so put
	// the workspace back on no dive before releasing it.
	const marker = join(bridge, "workspace", ".nosedive-ref");
	rmSync(marker);
	assertOk(run(["record.dive", "--ref", id, "--packer"], bridge), "record.dive --packer failed");
	const released = readFileSync(path, "utf8");
	assert.match(released, /^  diver: null$/m);
	assert.match(released, /^  packer: "?pilot@example\.test"?$/m);
	assert.equal(existsSync(marker), false, "releasing a dive must not activate it");
});

test("record.dive --packer refuses a dive held by another email", () => {
	const { bridge } = setup("packer-other");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--feat", featId, "--diver", "owner@example.test"], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const before = readFileSync(path, "utf8");
	const packed = run(["record.dive", "--ref", id, "--packer"], bridge);
	assert.notEqual(packed.status, 0, "--packer on somebody else's dive unexpectedly succeeded");
	assert.match(packed.stderr, /held by owner@example\.test/);
	assert.equal(readFileSync(path, "utf8"), before, "a refused --packer writes nothing");
});

test("record.dive --packer refuses a dive nobody holds", () => {
	const { bridge } = setup("packer-unheld");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const packed = run(["record.dive", "--ref", id, "--packer"], bridge);
	assert.notEqual(packed.status, 0, "--packer on an unheld dive unexpectedly succeeded");
	assert.match(packed.stderr, /not held/);
	assert.doesNotMatch(readFileSync(path, "utf8"), /^  packer:/m);
});

/**
 * There is one way to put down the dive you are on, and it is `pack` -- which
 * also clears the marker and resets the worktrees `--packer` knows nothing
 * about. The refusal has to name it or the pilot's only visible option is
 * editing the document by hand.
 */
test("record.dive --packer refuses the active workspace dive", () => {
	const { bridge } = setup("packer-active");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--feat", featId, "--diver", "pilot@example.test"], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	assert.match(
		readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"),
		new RegExp(`^id: ${id}\n$`),
	);
	const before = readFileSync(path, "utf8");
	const packed = run(["record.dive", "--ref", id, "--packer"], bridge);
	assert.equal(packed.status, 1);
	assert.match(packed.stderr, /is the active workspace dive/);
	assert.match(
		packed.stderr,
		/`pack`/,
		"the refusal must name the command that puts the dive down",
	);
	assert.equal(readFileSync(path, "utf8"), before, "a refused --packer writes nothing");
});

/**
 * The packer is derivable -- it is whoever the dive already says holds it -- so
 * accepting a value would only create a way to type it wrong.
 */
test("record.dive --packer takes no value and requires --ref", () => {
	const { bridge } = setup("packer-args");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--feat", featId, "--diver", "pilot@example.test"], bridge);
	assertOk(created, "record.dive create failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	const valued = run(["record.dive", "--ref", id, "--packer", "pilot@example.test"], bridge);
	assert.notEqual(valued.status, 0, "--packer <email> unexpectedly succeeded");
	assert.match(valued.stderr, /record\.dive found no document at: pilot@example\.test/);
	const bare = run(["record.dive", "--packer"], bridge, "");
	assert.notEqual(bare.status, 0, "--packer without --ref unexpectedly succeeded");
	assert.match(bare.stderr, /--packer requires --ref/);
});

test("record.dive links a claimed dive as planned while retaining its diver", () => {
	const { bridge } = setup("working-link");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--effort", featId, "--diver", "pilot@example.test"], bridge);
	assertOk(created, "record.dive create failed");
	const dive = readFileSync(recordedPath(bridge, created.stdout), "utf8");
	const id = /^id: (.+)$/m.exec(dive)[1];
	const effort = readFileSync(join(bridge, "kb", `${featId}.md`), "utf8");
	assert.match(dive, /^  diver: "?pilot@example\.test"?$/m);
	assert.match(effort, new RegExp(`- kb/${id}\\.md:\n      rel: planned\\.dive`));
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
	// No branch: nothing about an
	// unbriefed dive justifies somewhere to push, and naming no branch
	// is the whole of what read-only means.
	assert.match(doc, new RegExp(`^  - ${repoId}:\n      ref: ${repoCommit}$`, "m"));
	assert.doesNotMatch(doc, /^      work-branch: /m);
	assert.doesNotMatch(doc, /^      mode: /m);
	assert.doesNotMatch(doc, /^gist:/m);
	assert.doesNotMatch(doc, /^links:/m);
	assert.doesNotMatch(doc, /^# /m);
	// Claimed and on deck: finding work reads the workspace, and `append-log.dive`
	// and `bail` both act on whatever the marker names.
	assert.match(doc, /^  diver: "?test@nosedive\.invalid"?$/m);
	assert.equal(readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"), `id: ${id}\n`);
	// The agent that just made the dive is the one that has to fill it in, so it
	// is told what is missing without having to run preflight to find out.
	// `local-only` is absent because the command committed the doc it wrote, and
	// that tag reports the absence of exactly that commit.
	assert.match(result.stdout, /^needs: needs-name, needs-gist, needs-brief$/m);
	assert.ok(result.stdout.includes(`Committed dive(${id}): created`), result.stdout);
	// `jump` is feat-scoped and refuses a free dive, so the hints name what a
	// free dive can actually do next -- including the adoption that ends that.
	assert.doesNotMatch(result.stdout, /nosedive jump/);
	assert.match(result.stdout, new RegExp(`^nosedive record\\.dive ${id} --gist `, "m"));
	assert.match(result.stdout, /^nosedive append-log\.dive /m);
	assert.match(result.stdout, new RegExp(`^nosedive record\\.dive ${id} --feat <feat-ref> `, "m"));
	assert.match(result.stdout, /^nosedive bail --reason /m);
});

test("record.dive <ref> stops offering the gist step once a free dive has one", () => {
	const { bridge } = setupFree("free-gisted");
	const created = run(["record.dive", "--free"], bridge);
	assertOk(created, "record.dive --free failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	const gisted = run(["record.dive", id, "--gist", "what breaks"], bridge);
	assertOk(gisted, "record.dive <id> --gist failed");
	assert.doesNotMatch(gisted.stdout, /--gist </);
	assert.doesNotMatch(gisted.stdout, /nosedive jump/);
	assert.match(gisted.stdout, /^nosedive bail --reason /m);
});

test("record.dive <ref> --feat makes a free dive jumpable and says so", () => {
	const { bridge } = setupFree("free-adopted");
	const created = run(["record.dive", "--free"], bridge);
	assertOk(created, "record.dive --free failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	const adopted = run(["record.dive", id, "--feat", featId], bridge);
	assertOk(adopted, "record.dive <id> --feat failed");
	assert.match(adopted.stdout, new RegExp(`^nosedive jump kb/${id}\\.md$`, "m"));
});

test("record.dive --free requires an identity to claim the dive with", () => {
	const { bridge } = setupFree("free-nameless");
	// Emptied rather than unset: an unset local key falls through to the runner's
	// own global config, and the fixture would then depend on the machine.
	runTool("git", ["config", "user.email", ""], bridge);
	const result = run(["record.dive", "--free"], bridge, "");
	assert.notEqual(result.status, 0, "record.dive --free unexpectedly succeeded");
	assert.match(result.stderr, /--free requires git config user\.email/);
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
	const created = run(["record.dive", "--effort", featId], bridge);
	assertOk(created, "record.dive create failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	for (const extra of [
		["--effort", featId],
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

test("record.dive --free refuses over a dive already in flight", () => {
	const { bridge } = setupFree("free-active");
	// The claim only puts a dive on deck when it names the pilot the bridge
	// knows, and that is what makes this workspace occupied.
	runTool("git", ["config", "user.email", testDiver], bridge);
	const created = run(["record.dive", "--feat", featId, "--diver", testDiver], bridge);
	assertOk(created, "record.dive create failed");
	const id = /^id: (.+)$/m.exec(readFileSync(recordedPath(bridge, created.stdout), "utf8"))[1];
	const marker = join(bridge, "workspace", ".nosedive-ref");
	assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${id}\\n$`));
	const before = readdirSync(join(bridge, "kb")).length;
	const result = run(["record.dive", "--free"], bridge, "");
	assert.notEqual(result.status, 0, "record.dive --free unexpectedly succeeded");
	assert.match(result.stderr, /pilot already has active dive/);
	// The refusal happens before the document is written, so nothing is left on
	// disk that the marker never named.
	assert.equal(readdirSync(join(bridge, "kb")).length, before);
	assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${id}\\n$`));
});

/** A feat doc with an optional scope list and an optional parent edge. */
function writeFeat(bridge, id, name, { scopes = [], parent, parentRel = "parent" } = {}) {
	const lines = ["---", "kind: feat", `id: ${id}`, `name: ${name}`, `gist: "${name}"`];
	// A feat that scopes a repo says where its dives land, or they inherit nothing
	// pushable -- the branch is the fixture's way of saying "dives here publish".
	if (scopes.length > 0)
		lines.push(
			"scopes:",
			...scopes.flatMap((scope) => [`  - ${scope}:`, `      work-branch: work/${name}`]),
		);
	if (parent) lines.push("links:", `  - kb/${parent}.md:`, `      rel: ${parentRel}`);
	lines.push("---", "", `# ${name}`, "");
	write(join(bridge, "kb", `${id}.md`), lines.join("\n"));
}

const parentEffortId = "019fc623-0000-7000-8000-000000000006";
const childEffortId = "019fc623-0000-7000-8000-000000000007";

test("record.dive inherits scopes from the nearest scoped ancestor feat", () => {
	const { bridge, repoCommit } = setup("inherit");
	// `pitch` writes no scopes key at all, so the whole chain below the scoped
	// grandparent looks exactly like a freshly pitched pair of feats.
	writeFeat(bridge, parentEffortId, "middle.record-dive.nosedive", {
		parent: featId,
		parentRel: "parent.feat",
	});
	writeFeat(bridge, childEffortId, "leaf.middle.record-dive.nosedive", {
		parent: parentEffortId,
	});
	const result = run(["record.dive", "--effort", childEffortId], bridge);
	assertOk(result, "record.dive create failed");
	const doc = readFileSync(recordedPath(bridge, result.stdout), "utf8");
	assert.match(
		doc,
		// The branch comes from the feat that declared the scope, not the one the
		// dive names: an unscoped feat has said nothing about where repos land.
		new RegExp(
			`^  - ${repoId}:\n      ref: ${repoCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
	assert.doesNotMatch(doc, /^scopes: \[\]$/m);
});

test("record.dive stops the scope walk at the nearest scoped ancestor", () => {
	const { bridge } = setup("inherit-nearest");
	const nearer = join(bridge, "workspace", "nearer");
	const nearerCommit = createRepo(nearer, unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "nearer", "workspace/nearer");
	writeFeat(bridge, parentEffortId, "middle.record-dive.nosedive", {
		scopes: [unrelatedRepoId],
		parent: featId,
	});
	writeFeat(bridge, childEffortId, "leaf.middle.record-dive.nosedive", {
		parent: parentEffortId,
	});
	const result = run(["record.dive", "--effort", childEffortId], bridge);
	assertOk(result, "record.dive create failed");
	const doc = readFileSync(recordedPath(bridge, result.stdout), "utf8");
	assert.match(
		doc,
		new RegExp(
			`^  - ${unrelatedRepoId}:\n      ref: ${nearerCommit}\n      work-branch: work/middle.record-dive.nosedive$`,
			"m",
		),
	);
	assert.doesNotMatch(doc, new RegExp(`^  - ${repoId}:`, "m"));
});

/**
 * `--upscope` adds to the inherited set rather than replacing it, and
 * `--clear-scopes` alongside it is how a dive says it wants only what it named.
 * The superseded `--scope` spelling used to mean this; it names the scope a
 * `--repin <ref>` moves now, so upscoping has one spelling again.
 */
test("record.dive --upscope adds to the inherited set rather than replacing it", () => {
	const { bridge, repoCommit } = setup("inherit-override");
	const other = join(bridge, "workspace", "other");
	const otherCommit = createRepo(other, unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "other", "workspace/other");
	writeFeat(bridge, childEffortId, "leaf.record-dive.nosedive", { parent: featId });
	const added = run(
		["record.dive", "--effort", childEffortId, "--upscope", unrelatedRepoId],
		bridge,
	);
	assertOk(added, "record.dive create failed");
	const doc = readFileSync(recordedPath(bridge, added.stdout), "utf8");
	assert.match(
		doc,
		new RegExp(
			`^  - ${unrelatedRepoId}:\n      ref: ${otherCommit}\n      work-branch: work/leaf.record-dive.nosedive$`,
			"m",
		),
	);
	assert.match(
		doc,
		new RegExp(
			`^  - ${repoId}:\n      ref: ${repoCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
		"the inherited repo keeps the branch its own feat declared",
	);

	const only = run(
		["record.dive", "--effort", childEffortId, "--clear-scopes", "--upscope", unrelatedRepoId],
		bridge,
	);
	assertOk(only, "record.dive create failed");
	const replaced = readFileSync(recordedPath(bridge, only.stdout), "utf8");
	assert.doesNotMatch(replaced, new RegExp(`^  - ${repoId}:`, "m"));
});

test("record.dive warns when no ancestor scopes a repo", () => {
	const { bridge } = setup("inherit-empty");
	// A parent cycle: the walk must end on its own rather than spin, and still
	// report the empty result instead of writing `scopes: []` in silence.
	writeFeat(bridge, parentEffortId, "middle.record-dive.nosedive", { parent: childEffortId });
	writeFeat(bridge, childEffortId, "leaf.record-dive.nosedive", { parent: parentEffortId });
	const result = run(["record.dive", "--effort", childEffortId], bridge);
	assertOk(result, "record.dive create failed");
	assert.match(result.stderr, /and its ancestors scope no repos/);
	assert.match(readFileSync(recordedPath(bridge, result.stdout), "utf8"), /^scopes: \[\]$/m);
});

test("record.dive reassigns its reciprocal feat link", () => {
	const { bridge } = setup("patch-meta");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(["record.dive", "--effort", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// Put the dive back on the old spelling, which is what every dive recorded
	// before this change carries. Re-homing must not leave it behind, or the
	// document would name two feats and the parser would prefer one in silence.
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(`  feat: ${featId}`, `  effort: ${featId}`),
	);
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
	assert.match(doc, new RegExp(`^  feat: ${effort}$`, "m"));
	assert.doesNotMatch(doc, /^  effort: /m, "the superseded key must not survive a re-home");
	assert.match(doc, /^  diver: pilot@example\.test$/m);
	assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${id}\\n$`));
	const oldEffort = readFileSync(join(bridge, "kb", `${featId}.md`), "utf8");
	const newEffort = readFileSync(join(bridge, "kb", `${effort}.md`), "utf8");
	assert.doesNotMatch(oldEffort, new RegExp(`kb/${id}\\.md`));
	assert.equal((newEffort.match(new RegExp(`kb/${id}\\.md`, "g")) ?? []).length, 1);
	assert.match(newEffort, new RegExp(`- kb/${id}\\.md:\n      rel: planned\\.dive`));
});

/**
 * Every scope written before branches existed carries `mode`, and it decides
 * nothing: a `mode: rw` scope on a *dive* names no branch, so it is read-only
 * until somebody upscopes it. Only a feat's `mode: rw` still means anything, and
 * only as the thing its dives inherit.
 */
test("a dive scope's superseded mode decides nothing", () => {
	const { bridge } = setup("legacy-mode");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(/^      work-branch: .+$/m, "      mode: rw"),
	);
	const result = run(["record.dive", "--ref", id, "--gist", "Legacy."], bridge);
	assertOk(result, "a dive on the superseded key must still parse and patch");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, /^      mode: rw$/m, "nothing rewrites what it did not touch");
	assert.doesNotMatch(doc, /^      work-branch: /m);

	// Upscoping is what gives it somewhere to go, and that is when mode stops
	// being written at all.
	assertOk(run(["record.dive", "--ref", id, "--upscope", repoId], bridge), "--upscope failed");
	const upscoped = readFileSync(path, "utf8");
	assert.match(upscoped, /^      work-branch: work\/record-dive\.nosedive$/m);
	assert.doesNotMatch(upscoped, /^      mode: /m);
});

/**
 * `--repin` promises it changes nothing but the pin, and a scope written before
 * branches existed is where that promise costs something: `mode` is no longer
 * rendered, so rewriting the entry without the branch its feat hands down turns
 * a landable dive read-only with nothing said about it.
 */
test("record.dive --repin keeps a legacy mode: rw scope landable", () => {
	const { bridge, repoCommit } = setup("repin-legacy-mode");
	const otherCommit = createRepo(join(bridge, "workspace", "other"), unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "other", "workspace/other");
	// The feat declares a branch for `other` as well, so the read-only scope below
	// stays read-only because it never said `rw` -- not because the feat had
	// nothing to hand it. Without this the assertion would pass either way.
	const featPath = join(bridge, "kb", `${featId}.md`);
	writeFileSync(
		featPath,
		readFileSync(featPath, "utf8").replace(
			/^      work-branch: work\/record-dive\.nosedive$/m,
			`      work-branch: work/record-dive.nosedive\n  - ${unrelatedRepoId}:\n      work-branch: work/other.record-dive`,
		),
	);
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// Put the dive back on the pre-migration spelling, and strip the other scope's
	// branch outright, so one legacy `rw` and one genuine read-only go through the
	// same repin.
	writeFileSync(
		path,
		readFileSync(path, "utf8")
			.replace(/^      work-branch: work\/record-dive\.nosedive$/m, "      mode: rw")
			.replace(/\n      work-branch: work\/other\.record-dive$/m, ""),
	);
	const repinned = run(["record.dive", "--ref", id, "--repin"], bridge);
	assertOk(repinned, "record.dive --repin failed");
	const doc = readFileSync(path, "utf8");
	assert.match(
		doc,
		new RegExp(
			`^  - ${repoId}:\n      ref: ${repoCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
		"--repin must not take writability away from a scope that declared it as mode: rw",
	);
	assert.doesNotMatch(doc, /^      mode: /m);
	assert.match(
		doc,
		new RegExp(`^  - ${unrelatedRepoId}:\n      ref: ${otherCommit}$`, "m"),
		"a scope that never named a branch is read-only, and stays that way",
	);
	// Stated separately because `$` above anchors to the end of the ref line, not
	// the end of the entry: a branch appended underneath would slip past it.
	assert.doesNotMatch(
		doc,
		/work-branch: work\/other\.record-dive/,
		"the feat declares a branch for this repo and the repin must still not take it",
	);
});

test("record.dive --repin reports a legacy scope its feat cannot place", () => {
	const { bridge } = setup("repin-legacy-unplaceable");
	const otherCommit = createRepo(join(bridge, "workspace", "other"), unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "other", "workspace/other");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// The feat scopes `repo` and nothing else, so the legacy scope below has no
	// branch to inherit: losing writability is the honest outcome, saying nothing
	// about it is not.
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(
			new RegExp(`^  - ${repoId}:\n      ref: .+\n      work-branch: .+$`, "m"),
			`  - ${unrelatedRepoId}:\n      ref: ${otherCommit}\n      mode: rw`,
		),
	);
	const repinned = run(["record.dive", "--ref", id, "--repin"], bridge);
	assertOk(repinned, "record.dive --repin failed");
	assert.match(repinned.stderr, /mode: rw/);
	assert.match(repinned.stderr, /--upscope other/, "the report must name the fix");
	assert.doesNotMatch(readFileSync(path, "utf8"), /^      work-branch: /m);
});

/**
 * `--repin` resolves branches on origin, and the fixture repo doc names this
 * very checkout as `remotes.local`, so a branch committed here is a branch the
 * managed cache can fetch. Returns the branch head, which is what a repin has
 * to land on.
 */
function commitOnBranch(repo, branch, label) {
	const started = runTool("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo).stdout.trim();
	if (started !== branch) runTool("git", ["checkout", "-B", branch], repo);
	write(join(repo, `${label}.txt`), `${label}\n`);
	runTool("git", ["add", "--", `${label}.txt`], repo);
	gitCommit(repo, label);
	const head = runTool("git", ["rev-parse", "HEAD"], repo).stdout.trim();
	if (started !== branch) runTool("git", ["checkout", started], repo);
	return head;
}

/**
 * A stacked dive's pin is the branch its predecessor published to, so a scope
 * that names one is answered by that branch and not by the feat's -- the feat
 * declares where a repo lands in general, and the scope is the dive saying it
 * has been told otherwise.
 */
test("record.dive --repin pins a scope at its own work branch on origin", () => {
	const { bridge, repo, repoCommit } = setup("repin-scope-branch");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// Both branches are pushed after the dive is recorded, so the dive starts at
	// trunk and the repin has a move to make. A dive records at the head of the
	// branch it will publish to when one is already there, which is covered
	// elsewhere -- what is under test here is which branch answers the repin.
	const featHead = commitOnBranch(repo, "work/record-dive.nosedive", "feat-work");
	const scopeHead = commitOnBranch(repo, "work/scope-own", "scope-work");
	assert.notEqual(scopeHead, featHead, "the two branches must differ or the pin proves nothing");
	assertOk(
		run(
			["record.dive", "--ref", id, "--upscope", repoId, "--work-branch", "work/scope-own"],
			bridge,
		),
		"--upscope failed",
	);
	const repinned = run(["record.dive", "--ref", id, "--repin"], bridge);
	assertOk(repinned, "record.dive --repin failed");
	assert.match(
		readFileSync(path, "utf8"),
		new RegExp(`^  - ${repoId}:\n      ref: ${scopeHead}\n      work-branch: work/scope-own$`, "m"),
	);
	assert.match(
		repinned.stdout,
		new RegExp(`repo: ${repoCommit} -> ${scopeHead} \\(work-branch work/scope-own\\)`),
		"the move and the source that answered are both reported",
	);
});

/**
 * A scope naming no branch is read-only, and still has a pin worth moving: the
 * feat says where this repo's work is going, so that branch is the state the
 * dive should read it at. Repinning must not hand it the branch as well --
 * naming none is what read-only means.
 */
test("record.dive --repin falls back to the feat's branch for the repo", () => {
	const { bridge, repo, repoCommit } = setup("repin-feat-branch");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// Pushed after the dive is recorded, so the dive starts at trunk and the feat
	// branch is a move the repin has to make rather than one it inherited.
	const featHead = commitOnBranch(repo, "work/record-dive.nosedive", "feat-work");
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(/\n      work-branch: work\/record-dive\.nosedive$/m, ""),
	);
	const repinned = run(["record.dive", "--ref", id, "--repin"], bridge);
	assertOk(repinned, "record.dive --repin failed");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, new RegExp(`^  - ${repoId}:\n      ref: ${featHead}$`, "m"));
	assert.doesNotMatch(doc, /^      work-branch: /m, "a repin never hands a scope a branch");
	assert.match(
		repinned.stdout,
		new RegExp(`repo: ${repoCommit} -> ${featHead} \\(feat branch work/record-dive\\.nosedive\\)`),
	);
});

/**
 * Trunk is the last answer, not the only one, and a repin of several scopes has
 * to say which source answered for each: one branch nobody else can see moving
 * a pin in silence is what this report exists to prevent.
 */
test("record.dive --repin falls back to trunk and reports every scope", () => {
	const { bridge, repo, repoCommit } = setup("repin-trunk");
	const other = join(bridge, "workspace", "other");
	const otherCommit = createRepo(other, unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "other", "workspace/other");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// The feat scopes `repo` and nothing else, so `other` names no branch and has
	// none to inherit: trunk is all that is left to answer.
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(
			/^scopes:$/m,
			`scopes:\n  - ${unrelatedRepoId}:\n      ref: ${otherCommit}`,
		),
	);
	// Both branches move after the dive was written, which is the case a repin is
	// for -- and why its fetch cannot be skipped when the pin looks settled.
	const featHead = commitOnBranch(repo, "work/record-dive.nosedive", "feat-work");
	const otherTrunk = commitOnBranch(other, "main", "trunk-work");
	const repinned = run(["record.dive", "--ref", id, "--repin"], bridge);
	assertOk(repinned, "record.dive --repin failed");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, new RegExp(`^  - ${unrelatedRepoId}:\n      ref: ${otherTrunk}$`, "m"));
	assert.match(doc, new RegExp(`^  - ${repoId}:\n      ref: ${featHead}$`, "m"));
	assert.match(
		repinned.stdout,
		new RegExp(`other: ${otherCommit} -> ${otherTrunk} \\(trunk main\\)`),
	);
	assert.match(
		repinned.stdout,
		new RegExp(`repo: ${repoCommit} -> ${featHead} \\(work-branch work/record-dive\\.nosedive\\)`),
	);
});

/**
 * The first dive on a feat has pushed nothing, so its branch exists nowhere on
 * origin and trunk is the honest pin. The managed cache is a bare clone, so it
 * keeps a local branch of the same name long after origin drops it -- resolving
 * anywhere but origin would answer with a ref no other machine has.
 */
test("record.dive --repin resolves a work branch on origin only", () => {
	const { bridge, repo, repoCommit } = setup("repin-origin-only");
	const localOnly = commitOnBranch(repo, "work/record-dive.nosedive", "never-pushed");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// The branch is on origin when the dive is recorded, so the dive is born on
	// it -- and that is what puts it in the cache for the deletion below to leave
	// behind.
	assert.match(readFileSync(path, "utf8"), new RegExp(`^      ref: ${localOnly}$`, "m"));
	runTool("git", ["branch", "-D", "work/record-dive.nosedive"], repo);
	const cache = join(bridge, ".nosedive", "cache", repoId);
	const local = runTool(
		"git",
		["rev-parse", "--verify", "work/record-dive.nosedive^{commit}"],
		cache,
	);
	assert.equal(
		local.stdout.trim(),
		localOnly,
		"the cache must still hold the branch locally, or this proves nothing",
	);
	const repinned = run(["record.dive", "--ref", id, "--repin"], bridge);
	assertOk(repinned, "record.dive --repin failed");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, new RegExp(`^      ref: ${repoCommit}$`, "m"));
	assert.doesNotMatch(doc, new RegExp(localOnly), "a local-only branch must not answer");
	assert.match(repinned.stdout, new RegExp(`repo: ${localOnly} -> ${repoCommit} \\(trunk main\\)`));
});

/** Records a dive under the fixture feat and hands back its path and id. */
function recordDive(bridge, args = []) {
	const created = run(["record.dive", "--feat", featId, ...args], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	return { path, id: /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1] };
}

/**
 * A repin edits a document and moves no worktree, so which dive the workspace
 * happens to be on decides nothing. Holding an open dive and folding trunk into
 * it is the flow the old active-dive refusal blocked outright, and a worktree
 * sitting clean at its pin -- exactly what `pack` leaves behind -- has no
 * committed work a forward move could strand.
 */
test("record.dive --repin moves a pin on the active workspace dive", () => {
	const { bridge, repo, repoCommit } = setup("repin-active-clean");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const featHead = commitOnBranch(repo, "work/record-dive.nosedive", "feat-work");
	const { path, id } = recordDive(bridge, ["--diver", "pilot@example.test"]);
	const marker = join(bridge, "workspace", ".nosedive-ref");
	assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${id}\n$`), "the fixture must arm");
	const repinned = run(["record.dive", "--ref", id, "--repin"], bridge);
	assertOk(repinned, "a repin of the active dive must be allowed");
	assert.match(readFileSync(path, "utf8"), new RegExp(`^      ref: ${featHead}$`, "m"));
	assert.notEqual(featHead, repoCommit, "the fixture must actually move the pin");
});

/**
 * The pin is the base packed work replays onto, so the one thing a repin can
 * destroy is a commit the new pin cannot explain. `E` sits on top of the old pin
 * and the new pin never had it, so replaying `E` there would rebuild it on a
 * tree it was never written against.
 */
test("record.dive --repin refuses a scope whose commits the new pin would strand", () => {
	const { bridge, repo } = setup("repin-strands");
	const featHead = commitOnBranch(repo, "work/record-dive.nosedive", "feat-work");
	const { path, id } = recordDive(bridge);
	const stranded = commitOnBranch(repo, "main", "ahead");
	const before = readFileSync(path, "utf8");
	const repinned = run(["record.dive", "--ref", id, "--repin"], bridge);
	assert.equal(repinned.status, 1, "a repin that would strand committed work must refuse");
	assert.match(repinned.stderr, /\brepo\b/, "the refusal must name the repo");
	assert.match(repinned.stderr, new RegExp(stranded), "the refusal must name the stranded commit");
	assert.match(repinned.stderr, new RegExp(featHead), "the refusal must name the pin it refused");
	assert.match(repinned.stderr, /\bpack\b/, "the refusal must name the way to bank the work");
	assert.equal(readFileSync(path, "utf8"), before, "a refused repin writes nothing");
});

/**
 * The repin after a merge: the worktree sits on the work branch, the branch has
 * been merged, and the new pin is a trunk that contains it. HEAD and the merge
 * commit are on different lines of history, so neither is reachable the way the
 * backwards case is -- but the merge contains every commit the worktree holds,
 * so nothing can be stranded and the move must be allowed. Refusing here would
 * send the pilot to `pack` work that is already published.
 */
test("record.dive --repin <ref> --scope pins at a merge that contains HEAD", () => {
	const { bridge, repo, repoCommit } = setup("repin-merged");
	const branch = "work/record-dive.nosedive";
	// Pushed after the dive is recorded: a dive born on the branch would sit at
	// its head with nothing ahead of its pin, and a worktree ahead of its pin is
	// the only state the guard has anything to say about.
	const { path, id } = recordDive(bridge);
	assert.match(readFileSync(path, "utf8"), new RegExp(`^      ref: ${repoCommit}$`, "m"));
	const featHead = commitOnBranch(repo, branch, "feat-work");
	// The worktree sits on the work branch, ahead of its pin, and stays there:
	// that is the only state the guard has anything to say about.
	runTool("git", ["checkout", branch], repo);
	runTool("git", ["checkout", "main"], repo);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			`user.email=${testDiver}`,
			"merge",
			"--no-ff",
			"-m",
			"merge work",
			branch,
		],
		repo,
	);
	const merged = runTool("git", ["rev-parse", "HEAD"], repo).stdout.trim();
	runTool("git", ["checkout", branch], repo);
	assert.notEqual(merged, featHead, "the fixture must actually merge");
	const repinned = run(["record.dive", "--ref", id, "--repin", "main", "--scope", "repo"], bridge);
	assertOk(repinned, "a repin onto a commit that already contains HEAD must be allowed");
	assert.match(readFileSync(path, "utf8"), new RegExp(`^      ref: ${merged}$`, "m"));
});

/**
 * Folding in the dive this one was stacked on moves the pin *backwards*, and
 * that is always safe: the worktree's history still descends from the older
 * commit, so everything ahead of it replays.
 */
test("record.dive --repin <ref> --scope pins backwards at an ancestor of HEAD", () => {
	const { bridge, repo, repoCommit } = setup("repin-backwards");
	const moved = commitOnBranch(repo, "main", "trunk-work");
	const { path, id } = recordDive(bridge);
	assert.match(readFileSync(path, "utf8"), new RegExp(`^      ref: ${moved}$`, "m"));
	commitOnBranch(repo, "main", "ahead");
	runTool("git", ["branch", "base", repoCommit], repo);
	const repinned = run(["record.dive", "--ref", id, "--repin", "base", "--scope", "repo"], bridge);
	assertOk(repinned, "a repin onto an ancestor of HEAD must be allowed");
	assert.match(readFileSync(path, "utf8"), new RegExp(`^      ref: ${repoCommit}$`, "m"));
	assert.match(
		repinned.stdout,
		new RegExp(`repo: ${moved} -> ${repoCommit} \\(ref base\\)`),
		"an explicit ref reports itself as the source that answered",
	);
});

/**
 * Uncommitted work is captured against HEAD, not against the pin, so a pack
 * carries it whatever the pin says. A dirty worktree is therefore not a reason
 * to refuse anything -- only committed work ahead of the pin is at risk.
 */
test("record.dive --repin ignores a merely dirty worktree", () => {
	const { bridge, repo } = setup("repin-dirty");
	const featHead = commitOnBranch(repo, "work/record-dive.nosedive", "feat-work");
	const { path, id } = recordDive(bridge);
	write(join(repo, "dirty.txt"), "uncommitted\n");
	writeFileSync(join(repo, "README.md"), "edited\n");
	assertOk(run(["record.dive", "--ref", id, "--repin"], bridge), "a dirty tree must not block");
	assert.match(readFileSync(path, "utf8"), new RegExp(`^      ref: ${featHead}$`, "m"));
});

/**
 * A ref is repo-specific. Applying one repo's branch name to every scope in the
 * dive would be a footgun, so the two flags only mean anything together and
 * either one alone is a mistake rather than something to interpret.
 */
test("record.dive pairs --repin <ref> with --scope or refuses", () => {
	const { bridge } = setup("repin-scope-pairing");
	const { id } = recordDive(bridge);
	const unscoped = run(["record.dive", "--ref", id, "--repin", "main"], bridge, "");
	assert.notEqual(unscoped.status, 0, "--repin <ref> without --scope unexpectedly succeeded");
	assert.match(unscoped.stderr, /--repin <ref> requires --scope/);
	const unrepinned = run(["record.dive", "--ref", id, "--scope", "repo"], bridge, "");
	assert.notEqual(unrepinned.status, 0, "--scope without --repin <ref> unexpectedly succeeded");
	assert.match(unrepinned.stderr, /--scope requires --repin <ref>/);
});

/**
 * The commit a predecessor dive was pinned at is a thing the bridge already
 * knows, and making the pilot go and find the hash is how a stacked dive gets
 * folded in wrong. Only the named scope moves: the other one is a different
 * repo, about which a ref for this one says nothing.
 */
test("record.dive --repin <dive-quid> --scope pins at that dive's ref", () => {
	const { bridge, repo, repoCommit } = setup("repin-quid");
	const other = join(bridge, "workspace", "other");
	const otherCommit = createRepo(other, unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "other", "workspace/other");
	const earlier = recordDive(bridge);
	const moved = commitOnBranch(repo, "main", "trunk-work");
	const { path, id } = recordDive(bridge);
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(
			/^scopes:$/m,
			`scopes:\n  - ${unrelatedRepoId}:\n      ref: ${otherCommit}`,
		),
	);
	const repinned = run(
		["record.dive", "--ref", id, "--repin", earlier.id, "--scope", "repo"],
		bridge,
	);
	assertOk(repinned, "record.dive --repin <dive-quid> failed");
	const doc = readFileSync(path, "utf8");
	assert.match(doc, new RegExp(`^  - ${repoId}:\n      ref: ${repoCommit}`, "m"));
	assert.match(
		doc,
		new RegExp(`^  - ${unrelatedRepoId}:\n      ref: ${otherCommit}$`, "m"),
		"an explicit ref moves the scope it names and no other",
	);
	assert.match(
		repinned.stdout,
		new RegExp(`repo: ${moved} -> ${repoCommit} \\(dive ${earlier.id}\\)`),
		"the report must say which dive answered",
	);
});

/** A quid that answers no pin for this repo is a mistyped fold-in, not a git ref. */
test("record.dive --repin <quid> refuses a doc that is not a scoped dive", () => {
	const { bridge } = setup("repin-quid-refusals");
	const other = join(bridge, "workspace", "other");
	createRepo(other, unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "other", "workspace/other");
	const earlier = recordDive(bridge);
	const { id } = recordDive(bridge, ["--upscope", unrelatedRepoId]);
	const notADive = run(
		["record.dive", "--ref", id, "--repin", featId, "--scope", "repo"],
		bridge,
		"",
	);
	assert.notEqual(notADive.status, 0, "--repin <feat-quid> unexpectedly succeeded");
	assert.match(notADive.stderr, /does not resolve to a kind: dive doc/);
	const unscoped = run(
		["record.dive", "--ref", id, "--repin", earlier.id, "--scope", "other"],
		bridge,
		"",
	);
	assert.notEqual(unscoped.status, 0, "a dive with no scope for the repo unexpectedly answered");
	assert.match(unscoped.stderr, /scopes no repo other/);
});

/**
 * A repin is an edit to a document. Publishing it is the pilot's own act, so the
 * command leaves the bridge uncommitted and the remote untouched -- it reads
 * origin to resolve, and writes nothing back to it.
 */
test("record.dive --repin writes the dive and touches nothing else", () => {
	const { bridge, repo } = setup("repin-writes-only");
	commitOnBranch(repo, "work/record-dive.nosedive", "feat-work");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	const originRefs = runTool("git", ["show-ref"], repo).stdout;
	const bridgeHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout;
	assertOk(run(["record.dive", "--ref", id, "--repin"], bridge), "record.dive --repin failed");
	assert.equal(runTool("git", ["show-ref"], repo).stdout, originRefs, "a repin publishes nothing");
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], bridge).stdout,
		bridgeHead,
		"a repin commits nothing to the bridge",
	);
});

test("record.dive composes --upscope, --unscope and one --work-branch", () => {
	const { bridge } = setup("upscope");
	const secondCommit = createRepo(join(bridge, "workspace", "second"), unhydratedRepoId);
	writeRepoDoc(bridge, unhydratedRepoId, "second", "workspace/second");
	const thirdCommit = createRepo(join(bridge, "workspace", "third"), unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "third", "workspace/third");

	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	assert.match(readFileSync(path, "utf8"), new RegExp(`^  - ${repoId}:`, "m"));

	const edited = run(
		[
			"record.dive",
			"--ref",
			id,
			"--upscope",
			unhydratedRepoId,
			"--upscope",
			unrelatedRepoId,
			"--unscope",
			repoId,
			"--work-branch",
			"release/2026-08",
		],
		bridge,
	);
	assertOk(edited, "record.dive scope edit failed");
	const doc = readFileSync(path, "utf8");
	assert.doesNotMatch(doc, new RegExp(`^  - ${repoId}:`, "m"), "--unscope must drop the repo");
	// One branch covers every repo the call upscoped, which is the point of
	// composing them: repos moving together belong on one branch.
	assert.match(
		doc,
		new RegExp(
			`^  - ${unhydratedRepoId}:\n      ref: ${secondCommit}\n      work-branch: release/2026-08$`,
			"m",
		),
	);
	assert.match(
		doc,
		new RegExp(
			`^  - ${unrelatedRepoId}:\n      ref: ${thirdCommit}\n      work-branch: release/2026-08$`,
			"m",
		),
	);
});

test("record.dive resolves --upscope and --unscope repos by name", () => {
	const { bridge } = setup("upscope-by-name");
	const secondCommit = createRepo(join(bridge, "workspace", "second"), unhydratedRepoId);
	writeRepoDoc(bridge, unhydratedRepoId, "second", "workspace/second");

	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];

	// A repo doc's name is what a pilot has in their head, and it is shorter than
	// a uuid and unambiguous within the bridge.
	const edited = run(
		["record.dive", "--ref", id, "--upscope", "second", "--unscope", "repo"],
		bridge,
	);
	assertOk(edited, "record.dive scope edit by repo name failed");
	const doc = readFileSync(path, "utf8");
	assert.doesNotMatch(doc, new RegExp(`^  - ${repoId}:`, "m"), "--unscope by name must drop it");
	assert.match(
		doc,
		new RegExp(
			`^  - ${unhydratedRepoId}:\n      ref: ${secondCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
});

test("record.dive --upscope defaults to the feat's branch and keeps an existing pin", () => {
	const { bridge, repoCommit } = setup("upscope-default");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// Take the branch away, then put it back with --upscope: an already-scoped
	// repo keeps the pin it has, because upscoping decides where work goes and
	// never which commit it started from.
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(/^      work-branch: .+$/m, "      mode: ro"),
	);
	const edited = run(["record.dive", "--ref", id, "--upscope", repoId], bridge);
	assertOk(edited, "record.dive --upscope failed");
	assert.match(
		readFileSync(path, "utf8"),
		new RegExp(
			`^  - ${repoId}:\n      ref: ${repoCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
});

test("record.dive refuses contradictory or homeless scope edits", () => {
	const { bridge } = setup("upscope-refusals");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];

	const contested = run(
		["record.dive", "--ref", id, "--upscope", repoId, "--unscope", repoId],
		bridge,
	);
	assert.notEqual(contested.status, 0, "one repo cannot be both upscoped and unscoped");
	assert.match(contested.stderr, /--upscope and --unscope name the same repo/);

	const homeless = run(["record.dive", "--ref", id, "--work-branch", "release/x"], bridge);
	assert.notEqual(homeless.status, 0, "a branch with nothing to apply it to is a mistake");
	assert.match(homeless.stderr, /--upscope <repo>/);
});

/**
 * A dive is born where the branch it will publish to already stands.
 *
 * The second dive on a feat is what this is for. Its predecessor's `land` moved
 * the feat's branch past trunk, so a dive pinned at trunk is behind the branch
 * it is about to push to before anybody has touched it, and `land` can only
 * refuse. `scripts/test/lifecycle.mjs` proves the whole arc; this pins the rule.
 */
test("record.dive pins a new dive at its feat's branch on origin", () => {
	const { bridge, repo, repoCommit } = setup("create-at-feat-branch");
	const published = commitOnBranch(repo, "work/record-dive.nosedive", "landed-work");
	assert.notEqual(published, repoCommit, "the fixture must move the branch off trunk");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	assert.match(
		readFileSync(recordedPath(bridge, created.stdout), "utf8"),
		new RegExp(
			`^  - ${repoId}:\n      ref: ${published}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
});

/**
 * The first dive on a feat has published nothing, so there is no branch to read
 * and trunk is the only honest answer -- unchanged, and the case nearly every
 * other test in this file runs through.
 */
test("record.dive pins a new dive at trunk when its feat's branch is unpublished", () => {
	const { bridge, repoCommit } = setup("create-at-trunk");
	const created = run(["record.dive", "--feat", featId], bridge);
	assertOk(created, "record.dive create failed");
	assert.match(
		readFileSync(recordedPath(bridge, created.stdout), "utf8"),
		new RegExp(
			`^  - ${repoId}:\n      ref: ${repoCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
});

/**
 * A repo joining a dive mid-flight is the same question as a repo joining it at
 * create: it has no pin to keep, so it starts where the branch it is joining
 * stands. An already-scoped repo keeps its pin, which the test above this one
 * covers.
 */
test("record.dive --upscope pins a newly scoped repo at its branch on origin", () => {
	const { bridge } = setup("upscope-at-branch");
	const other = join(bridge, "workspace", "other");
	const otherCommit = createRepo(other, unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "other", "workspace/other");
	const published = commitOnBranch(other, "work/shared", "other-work");
	assert.notEqual(published, otherCommit, "the fixture must move the branch off trunk");
	const { id } = recordDive(bridge);
	const edited = run(
		["record.dive", "--ref", id, "--upscope", unrelatedRepoId, "--work-branch", "work/shared"],
		bridge,
	);
	assertOk(edited, "record.dive --upscope failed");
	assert.match(
		readFileSync(join(bridge, "kb", `${id}.md`), "utf8"),
		new RegExp(
			`^  - ${unrelatedRepoId}:\n      ref: ${published}\n      work-branch: work/shared$`,
			"m",
		),
	);
});
