import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, gitCommit, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("drop");
const promptId = "019fd9e1-26e2-785d-937b-d3c722074683";
const featId = "019fd96e-b1f1-7770-aa0b-45d95c3b30a6";
const memoId = "019fd96e-b1f1-7770-aa0b-45d95c3b30a7";
const diveId = "019fd96e-b1f1-7770-aa0b-45d95c3b30a8";
const repoId = "019fd96e-b1f1-7770-aa0b-45d95c3b30a9";
const gateId = "019fd96e-b1f1-7770-aa0b-45d95c3b30aa";

function createDroppableBridge(name) {
	const bridge = createBridge(tmp, name);
	write(
		join(bridge, "kb", `${promptId}.md`),
		`---
kind: idea
id: ${promptId}
name: drop.prompt
gist: "Drop prompt."
---

# Drop It

SHIP THIS BODY VERBATIM.
`,
	);
	write(
		join(bridge, ".nosedive", "config.yaml"),
		`compatibility-level: 2
workspace: ./workspace
kb: ./kb
work-branch-prefix: work/
drop-prompt: ${promptId}
`,
	);
	return bridge;
}

function writeFeat(
	bridge,
	{ kind = "feat", name = "ship-it.development", target, scopes = [], links = [] } = {},
) {
	const lines = [
		"---",
		`kind: ${kind}`,
		`id: ${featId}`,
		`name: ${name}`,
		'gist: "Ship the completed work."',
	];
	if (scopes.length > 0) lines.push("scopes:", ...scopes.map((id) => `  - ${id}`));
	if (links.length > 0) {
		lines.push("links:");
		for (const link of links) lines.push(`  - kb/${link.id}.md:`, `      rel: ${link.rel}`);
	}
	if (target) lines.push("meta:", `  target: ${target}`);
	lines.push("---", "", "# Ship It", "");
	write(join(bridge, "kb", `${featId}.md`), lines.join("\n"));
}

function writeLinkedDoc(bridge, id, kind, name) {
	write(
		join(bridge, "kb", `${id}.md`),
		`---
kind: ${kind}
id: ${id}
name: ${name}
gist: "Linked drop fixture."
---
`,
	);
}

function createCloudBranch(name, branch) {
	const source = join(tmp, `${name}-source`);
	const cloud = join(tmp, `${name}-cloud.git`);
	mkdirSync(source, { recursive: true });
	mkdirSync(cloud, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "README.md"), `${name}\n`);
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, "fixture");
	runTool("git", ["init", "--bare", "-b", "main"], cloud);
	runTool("git", ["remote", "add", "cloud", cloud], source);
	runTool("git", ["push", "cloud", `HEAD:refs/heads/${branch}`], source);
	const sha = runTool("git", ["rev-parse", "HEAD"], source).stdout.trim();
	return { cloud: cloud.replaceAll("\\", "/"), sha };
}

function writeRepo(bridge, cloud, merge = "pull-request") {
	const mergeLine = merge === null ? "" : `  merge: ${merge}\n`;
	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: app
gist: "App repo."
meta:
  path: workspace/app
  trunk: main
${mergeLine}  branch-convention: feature branches
  remotes:
    cloud: ${cloud}
---
`,
	);
}

test("drop prints a ready feat context after the prompt body", () => {
	const bridge = createDroppableBridge("ready");
	const branch = "work/ship-it.development";
	const { cloud, sha } = createCloudBranch("ready", branch);
	writeLinkedDoc(bridge, memoId, "memo", "landed-dive");
	writeRepo(bridge, cloud);
	write(
		join(bridge, "kb", `${gateId}.md`),
		`---
kind: gate
id: ${gateId}
name: app-tests
gist: "App tests."
meta:
  test-script: kb/app-tests.mjs
---
`,
	);
	write(join(bridge, "kb", "app-tests.mjs"), "export function run() { return true; }\n");
	writeFeat(bridge, {
		scopes: [repoId],
		links: [
			{ id: memoId, rel: "working" },
			{ id: gateId, rel: "land.gate" },
		],
	});

	const dropped = run(["drop", "ship it"], bridge);
	assert.equal(dropped.status, 0, dropped.stderr);
	assert.equal(dropped.stderr, "");
	assert.ok(dropped.stdout.indexOf("SHIP THIS BODY VERBATIM.") < dropped.stdout.indexOf("## Drop"));
	assert.match(dropped.stdout, /^feat: ship-it\.development$/m);
	assert.match(dropped.stdout, new RegExp(`^doc: kb/${featId}\\.md$`, "m"));
	assert.match(dropped.stdout, /^gist: Ship the completed work\.$/m);
	assert.match(dropped.stdout, /^target: \(none\)$/m);
	assert.match(dropped.stdout, /^note: no kind: repo doc matches a bridge git remote;/m);
	assert.match(dropped.stdout, /^### Blockers\n\n\(none\)$/m);
	assert.match(dropped.stdout, /^- app -- workspace\/app$/m);
	assert.match(dropped.stdout, /^    merge: pull-request$/m);
	assert.match(dropped.stdout, /^    branch-convention: feature branches$/m);
	assert.match(dropped.stdout, new RegExp(`^    work branch: ${branch} -> ${sha}$`, "m"));
	assert.match(
		dropped.stdout,
		new RegExp(`^    nosedive test ${gateId}    # app-tests \\(height 0\\)$`, "m"),
	);
	assert.match(dropped.stdout, new RegExp(`^1\\. Close kb/${featId}\\.md:`, "m"));
});

test("drop reports an open dive only on stderr", () => {
	const bridge = createDroppableBridge("open-dive");
	writeLinkedDoc(bridge, memoId, "memo", "landed-dive");
	writeLinkedDoc(bridge, diveId, "dive", "unfinished-slice");
	writeFeat(bridge, {
		links: [
			{ id: memoId, rel: "landed.dive" },
			{ id: diveId, rel: "jumped.dive" },
		],
	});

	const dropped = run(["drop", "ship-it.development"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "");
	assert.match(dropped.stderr, /open dive: unfinished-slice/);
	assert.doesNotMatch(dropped.stderr, /no landed dive/);
});

test("drop still recognizes legacy working dive rels", () => {
	const bridge = createDroppableBridge("legacy-open-dive");
	writeLinkedDoc(bridge, memoId, "memo", "landed-dive");
	writeLinkedDoc(bridge, diveId, "dive", "unfinished-slice");
	writeFeat(bridge, {
		links: [
			{ id: memoId, rel: "working" },
			{ id: diveId, rel: "working" },
		],
	});

	const dropped = run(["drop", "ship-it.development"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "");
	assert.match(dropped.stderr, /open dive: unfinished-slice/);
	assert.doesNotMatch(dropped.stderr, /no landed dive/);
});

test("drop blocks a packed dive", () => {
	const bridge = createDroppableBridge("packed-dive");
	writeLinkedDoc(bridge, memoId, "memo", "landed-dive");
	writeLinkedDoc(bridge, diveId, "dive", "packed-slice");
	writeFeat(bridge, {
		links: [
			{ id: memoId, rel: "landed.dive" },
			{ id: diveId, rel: "packed.dive" },
		],
	});

	const dropped = run(["drop", "ship-it.development"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "");
	assert.match(dropped.stderr, /open dive: packed-slice/);
	assert.doesNotMatch(dropped.stderr, /no landed dive/);
});

test("drop blocks a feat with no landed dive", () => {
	const bridge = createDroppableBridge("no-landed-dive");
	writeFeat(bridge);

	const dropped = run(["drop", "ship-it.development"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "");
	assert.match(dropped.stderr, /no landed dive/);
});

test("an open child blocks, and a closed one stops blocking", () => {
	const childId = "019fd96e-b1f1-7770-aa0b-45d95c3b30ab";
	const bridge = createDroppableBridge("open-child");
	writeLinkedDoc(bridge, memoId, "memo", "landed-dive");
	writeLinkedDoc(bridge, childId, "feat", "unfinished-child");
	writeFeat(bridge, {
		links: [
			{ id: memoId, rel: "working" },
			{ id: childId, rel: "child" },
		],
	});
	assert.match(run(["drop", "ship-it.development"], bridge).stderr, /open child feat/);

	// Closing a feat rewrites its kind and leaves the edge in place, so the
	// blocker has to read done-ness rather than the presence of the link.
	writeLinkedDoc(bridge, childId, "memo", "unfinished-child");
	const reopened = run(["drop", "ship-it.development"], bridge);
	assert.doesNotMatch(reopened.stderr, /open child feat/);
});

test("drop blocks a scoped repo with no merge policy", () => {
	const bridge = createDroppableBridge("no-merge");
	const branch = "work/ship-it.development";
	const { cloud } = createCloudBranch("no-merge", branch);
	writeLinkedDoc(bridge, memoId, "memo", "landed-dive");
	writeRepo(bridge, cloud, null);
	writeFeat(bridge, { scopes: [repoId], links: [{ id: memoId, rel: "working" }] });

	const dropped = run(["drop", "ship-it.development"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "");
	assert.match(dropped.stderr, new RegExp(`repo app has no meta\\.merge; fix kb/${repoId}\\.md`));
});

test("drop does not block a future target date", () => {
	const bridge = createDroppableBridge("future-target");
	writeLinkedDoc(bridge, memoId, "memo", "landed-dive");
	writeFeat(bridge, { target: "2999-01-01", links: [{ id: memoId, rel: "working" }] });

	const dropped = run(["drop", "ship-it.development"], bridge);
	assert.equal(dropped.status, 0, dropped.stderr);
	assert.match(dropped.stdout, /^target: 2999-01-01$/m);
});

test("drop treats an already closed feat as not found", () => {
	const bridge = createDroppableBridge("closed");
	writeFeat(bridge, { kind: "memo" });

	const dropped = run(["drop", "ship-it.development"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "");
	assert.match(dropped.stderr, /drop not found: ship-it\.development/);
});

test("drop reports every candidate for an ambiguous slug", () => {
	const bridge = createDroppableBridge("ambiguous");
	writeFeat(bridge, { name: "twin.release" });
	write(
		join(bridge, "kb", "019fd96e-b1f1-7770-aa0b-45d95c3b30ab.md"),
		`---
kind: feat
id: 019fd96e-b1f1-7770-aa0b-45d95c3b30ab
name: twin.development
gist: "Twin."
---
`,
	);

	const dropped = run(["drop", "twin"], bridge);
	assert.equal(dropped.status, 1);
	assert.equal(dropped.stdout, "");
	assert.match(dropped.stderr, /drop name is ambiguous: twin \(twin\.development, twin\.release\)/);
});
