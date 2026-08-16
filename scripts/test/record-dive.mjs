import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
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
	const result = run(["record.dive", "--effort", effortId], bridge);
	assertOk(result, "record.dive create failed");
	const doc = readFileSync(recordedPath(bridge, result.stdout), "utf8");
	assert.match(doc, /^kind: dive$/m);
	assert.match(doc, /^name: record-dive\.nosedive\.[0-9a-f]{6}$/m);
	assert.match(doc, /^gist: "Working on Record Dive\."$/m);
	assert.match(doc, new RegExp(`^  feat: ${effortId}$`, "m"));
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
	const result = run(["record.dive", "--feat", effortId], bridge);
	assertOk(result, "record.dive create with --feat failed");
	const doc = readFileSync(recordedPath(bridge, result.stdout), "utf8");
	assert.match(doc, /^kind: dive$/m);
	assert.match(doc, /^name: record-dive\.nosedive\.[0-9a-f]{6}$/m);
	assert.match(doc, new RegExp(`^  feat: ${effortId}$`, "m"));
	assert.match(
		doc,
		new RegExp(
			`^  - ${repoId}:\n      ref: ${repoCommit}\n      work-branch: work/record-dive.nosedive$`,
			"m",
		),
	);
});

test("record.dive accepts --effort as a compatibility alias", () => {
	const { bridge } = setup("create-effort-alias");
	const result = run(["record.dive", "--effort", effortId], bridge);
	assertOk(result, "record.dive create with --effort alias failed");
	assert.match(readFileSync(recordedPath(bridge, result.stdout), "utf8"), /^kind: dive$/m);
});

test("record.dive accepts matching --feat and --effort refs", () => {
	const { bridge } = setup("create-matching-feat-effort");
	const result = run(["record.dive", "--feat", effortId, "--effort", effortId], bridge);
	assertOk(result, "record.dive create with matching --feat and --effort failed");
	assert.match(
		readFileSync(recordedPath(bridge, result.stdout), "utf8"),
		new RegExp(`^  feat: ${effortId}$`, "m"),
	);
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

test("record.dive patches the owning feat with --feat", () => {
	const { bridge } = setup("patch-feat");
	const created = run(["record.dive", "--feat", effortId], bridge);
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
		["record.dive", "--feat", effortId, "--effort", "019fc623-0000-7000-8000-000000000099"],
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
		["record.dive", "--effort", effortId, "--scope", repoId, "--clear-scopes"],
		bridge,
	);
	assertOk(replaced, "clearing then scoping should be accepted");
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

test("record.dive records for others while a dive is active, and claims for nobody else", () => {
	const { bridge } = setup("record-while-active");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const held = run(["record.dive", "--effort", effortId, "--diver", "pilot@example.test"], bridge);
	assertOk(held, "record.dive create failed");
	const marker = join(bridge, "workspace", ".nosedive-ref");
	const activeId = /^id: (.+)$/m.exec(readFileSync(marker, "utf8"))[1];

	// Writing up work for the backlog touches no marker, so the dive the
	// workspace holds has no bearing on it.
	for (const extra of [[], ["--diver", "other@example.test"]]) {
		const recorded = run(["record.dive", "--effort", effortId, ...extra], bridge);
		assertOk(recorded, `record.dive ${extra.join(" ")} refused while a dive was active`);
		assert.match(readFileSync(marker, "utf8"), new RegExp(`^id: ${activeId}\\n$`));
	}

	// Claiming is the part that cannot happen twice.
	const claimed = run(
		["record.dive", "--effort", effortId, "--diver", "pilot@example.test"],
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

test("record.dive links a claimed dive as planned while retaining its diver", () => {
	const { bridge } = setup("working-link");
	runTool("git", ["config", "user.email", "pilot@example.test"], bridge);
	const created = run(
		["record.dive", "--effort", effortId, "--diver", "pilot@example.test"],
		bridge,
	);
	assertOk(created, "record.dive create failed");
	const dive = readFileSync(recordedPath(bridge, created.stdout), "utf8");
	const id = /^id: (.+)$/m.exec(dive)[1];
	const effort = readFileSync(join(bridge, "kb", `${effortId}.md`), "utf8");
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
	// unbriefed, unclaimed dive justifies somewhere to push, and naming no branch
	// is the whole of what read-only means.
	assert.match(doc, new RegExp(`^  - ${repoId}:\n      ref: ${repoCommit}$`, "m"));
	assert.doesNotMatch(doc, /^      work-branch: /m);
	assert.doesNotMatch(doc, /^      mode: /m);
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
		parent: effortId,
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
		parent: effortId,
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
 * `--scope` used to replace the inherited set. It is the old spelling of
 * `--upscope` now, so it adds a repo instead -- and `--clear-scopes` alongside
 * it is how a dive says it wants only what it named.
 */
test("record.dive --scope adds to the inherited set rather than replacing it", () => {
	const { bridge, repoCommit } = setup("inherit-override");
	const other = join(bridge, "workspace", "other");
	const otherCommit = createRepo(other, unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "other", "workspace/other");
	writeFeat(bridge, childEffortId, "leaf.record-dive.nosedive", { parent: effortId });
	const added = run(["record.dive", "--effort", childEffortId, "--scope", unrelatedRepoId], bridge);
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
		["record.dive", "--effort", childEffortId, "--clear-scopes", "--scope", unrelatedRepoId],
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
	const created = run(["record.dive", "--effort", effortId], bridge);
	assertOk(created, "record.dive create failed");
	const path = recordedPath(bridge, created.stdout);
	const id = /^id: (.+)$/m.exec(readFileSync(path, "utf8"))[1];
	// Put the dive back on the old spelling, which is what every dive recorded
	// before this change carries. Re-homing must not leave it behind, or the
	// document would name two feats and the parser would prefer one in silence.
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace(`  feat: ${effortId}`, `  effort: ${effortId}`),
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
	const oldEffort = readFileSync(join(bridge, "kb", `${effortId}.md`), "utf8");
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
	const created = run(["record.dive", "--feat", effortId], bridge);
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

test("record.dive composes --upscope, --unscope and one --work-branch", () => {
	const { bridge } = setup("upscope");
	const secondCommit = createRepo(join(bridge, "workspace", "second"), unhydratedRepoId);
	writeRepoDoc(bridge, unhydratedRepoId, "second", "workspace/second");
	const thirdCommit = createRepo(join(bridge, "workspace", "third"), unrelatedRepoId);
	writeRepoDoc(bridge, unrelatedRepoId, "third", "workspace/third");

	const created = run(["record.dive", "--feat", effortId], bridge);
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

test("record.dive --upscope defaults to the feat's branch and keeps an existing pin", () => {
	const { bridge, repoCommit } = setup("upscope-default");
	const created = run(["record.dive", "--feat", effortId], bridge);
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
	const created = run(["record.dive", "--feat", effortId], bridge);
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
	assert.match(homeless.stderr, /--work-branch requires at least one --upscope/);
});
