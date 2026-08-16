import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	cli,
	createTmp,
	gitCommit,
	gitCommitEmpty,
	run,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("land-gates");
const repoId = "019fd471-0000-7000-8000-000000000001";
const featId = "019fd471-0000-7000-8000-000000000002";
const legacyGateRel = "land-gated-by";

/**
 * Gate scripts live in the bridge (meta.test-script is bridge-relative), so
 * they are written into each temp bridge rather than copied from a fixtures
 * directory. Each exports `run(ctx)`, reports on stderr, and fails by throwing
 * or returning false -- the whole gate contract.
 */
const GATE_PASS = 'export function run() {\n\tconsole.error("gate ok");\n}\n';
const GATE_FAIL =
	'export function run() {\n\tconsole.error("gate says no");\n\tthrow new Error("gate says no");\n}\n';
const GATE_FALSE =
	'export function run() {\n\tconsole.error("returned false");\n\treturn false;\n}\n';
const GATE_TEST_FAIL =
	'import { test } from "node:test";\n\ntest("gate assertion", () => {\n\tthrow new Error("test says no");\n});\n\nexport function run() {}\n';
const GATE_TEST_PASS =
	'import { test } from "node:test";\n\ntest("gate assertion", () => {});\n\nexport function run() {}\n';
/** Outlives any idle limit the test sets, but never goes quiet for one. */
const GATE_TEST_TALKS_WHILE_SLOW =
	'import { test } from "node:test";\n\ntest("slow but talking", async () => {\n\tfor (let i = 0; i < 6; i++) {\n\t\tconsole.error("tick " + i);\n\t\tawait new Promise((r) => setTimeout(r, 300));\n\t}\n});\n\nexport function run() {}\n';
/** Returns cleanly, then holds the loop open saying nothing -- the hang case. */
const GATE_HANGS_SILENTLY = "export function run() {\n\tsetTimeout(() => {}, 60000);\n}\n";
const GATE_SLOW =
	'export function run() {\n\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n\tconsole.error("slow gate finished");\n}\n';
/** Speaks, then stalls: the only shape that can tell streaming from buffering. */
const GATE_TALKS_THEN_STALLS =
	'export function run() {\n\tconsole.error("gate speaking early");\n\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);\n}\n';
const orderGate = (logPath, name) =>
	`import { appendFileSync } from "node:fs";\n\nexport function run() {\n\tappendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${name}\n`)});\n}\n`;
const contextGate = (logPath) =>
	`import { writeFileSync } from "node:fs";\n\nexport function run(ctx) {\n\twriteFileSync(${JSON.stringify(logPath)}, JSON.stringify(ctx));\n}\n`;
/**
 * The navigation the branch-convention gate will do: from its own repo, through
 * the dive, to the scope entry that says where that repo's work goes.
 */
const scopeReadingGate = (logPath) => `import { writeFileSync } from "node:fs";

export async function run(ctx) {
	const repo = ctx.repos[Object.keys(ctx.repos)[0]];
	const dive = await ctx.resolve(ctx.diveId);
	const scope = dive.scopes.find((entry) => entry.repoId === repo.id);
	if (!scope) throw new Error("the dive does not scope " + repo.id);
	writeFileSync(
		${JSON.stringify(logPath)},
		JSON.stringify({ kind: dive.kind, repoId: repo.id, workBranch: scope.workBranch }),
	);
}
`;
/** A gate that asks for a document nobody wrote must fail, never pass quietly. */
const GATE_RESOLVES_NOTHING = `export async function run(ctx) {
	await ctx.resolve("00000000-0000-7000-8000-00000000dead");
}
`;
/** Resolves its repo through ctx, from the bridge, the way every gate must. */
const GATE_ECHO_HEAD = `import { execFileSync } from "node:child_process";

export function run(ctx) {
	const repo = ctx.repos[Object.keys(ctx.repos)[0]];
	console.error("cwd=" + process.cwd());
	console.error("root=" + repo.root);
	console.error(
		execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.root, encoding: "utf8" }).trim(),
	);
}
`;

function gateDoc(
	id,
	name,
	{ kind = "assertion", script = `kb/artifacts/${id}.mjs`, scoped = false } = {},
) {
	const meta = script === null ? "meta:\n" : `meta:\n  test-script: ${script}\n`;
	const scopes = scoped ? `scopes:\n  - ${repoId}:\n      mode: ro\n` : "scopes: []\n";
	return `---
kind: ${kind}
id: ${id}
name: ${name}
gist: "Gate ${name}"
${scopes}${meta}---

# ${name}
`;
}

/**
 * @param name unique per test; also names the workspace repo
 * @param gates array of { id, name, body, links } written into kb and linked
 * @param linkFrom "dive" | "feat" -- which doc carries the land.gate edges
 */
function setup(name, gates = [], { linkFrom = "feat", extraDocs = [] } = {}) {
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
gist: "Gate test repo"
meta:
  path: workspace/${name}-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
---
`,
	);

	for (const gate of gates) {
		write(join(bridge, "kb", `${gate.id}.md`), gate.doc);
		if (gate.script !== undefined) {
			write(join(bridge, "kb", "artifacts", `${gate.id}.mjs`), gate.script);
		}
	}
	for (const doc of extraDocs) write(join(bridge, "kb", `${doc.id}.md`), doc.body);

	const gateLinks = gates
		.filter((gate) => gate.link !== false)
		.map((gate) => {
			const attrs = { rel: "land.gate", ...(gate.attrs ?? {}) };
			const attrLines = Object.entries(attrs)
				.map(([key, value]) => `      ${key}: ${value}`)
				.join("\n");
			return `  - kb/${gate.id}.md:\n${attrLines}`;
		})
		.join("\n");

	write(
		join(bridge, "kb", `${featId}.md`),
		`---
kind: feat
id: ${featId}
name: land-gates.nosedive
gist: "Gate test feat"
scopes:
  - ${repoId}:
      work-branch: work/land-gates.nosedive
${linkFrom === "feat" && gateLinks ? `links:\n${gateLinks}\n` : ""}---
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
		["record.dive", "--feat", featId, "--diver", "nosedive@example.invalid"],
		bridge,
	);
	assertOk(dive, "record.dive failed");
	const diveId = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(dive.stdout)?.[1];
	assert.ok(diveId, `record.dive did not report a dive id:\n${dive.stdout}`);

	if (linkFrom === "dive" && gateLinks) {
		const divePath = join(bridge, "kb", `${diveId}.md`);
		const text = readFileSync(divePath, "utf8");
		write(divePath, text.replace(/\n---\n/, `\nlinks:\n${gateLinks}\n---\n`));
	}

	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "record dive");
	return { bridge, worktree: join(bridge, "workspace", `${name}-repo`), diveId };
}

function gate(id, name, script, attrs, options = {}) {
	return { id, name, script, attrs, doc: gateDoc(id, name, options), ...options };
}

test("a dive with no gates still lands", () => {
	const { bridge, worktree } = setup("no-gates");
	gitCommitEmpty(worktree, "work");
	assertOk(run(["land"], bridge), "land without gates should push");
});

test("wide gate walks do not descend into sibling dives", () => {
	const gateId = "019fd471-0000-7000-8000-000000000040";
	const siblingId = "019fd471-0000-7000-8000-000000000041";
	const backlogId = "019fd471-0000-7000-8000-000000000042";
	const featGateId = "019fd471-0000-7000-8000-000000000043";
	const logPath = join(tmp, "sibling-dive-gate.json");
	const { bridge, worktree, diveId } = setup("sibling-dive", [
		gate(gateId, "sibling-only", contextGate(logPath), undefined, { link: false }),
		gate(featGateId, "feat-regression", GATE_PASS, undefined, { link: false }),
	]);
	write(
		join(bridge, "kb", `${siblingId}.md`),
		`---
kind: dive
id: ${siblingId}
name: sibling-dive
gist: "Work belonging to another dive"
feat: ${featId}
scopes: []
links:
  - kb/${gateId}.md:
      rel: test.gate
  - kb/${gateId}.md:
      rel: land.gate
---
`,
	);
	const featPath = join(bridge, "kb", `${featId}.md`);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			/^links:\n/m,
			`links:\n  - kb/${siblingId}.md:\n      rel: working.dive\n  - kb/${featGateId}.md:\n      rel: test.gate\n`,
		),
	);
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---
kind: memo
id: ${backlogId}
name: backlog
gist: "Regression roots"
scopes: []
links:
  - kb/${featId}.md:
      rel: active.feat
---
`,
	);
	const configPath = join(bridge, ".nosedive", "config.yaml");
	write(configPath, `${readFileSync(configPath, "utf8").trimEnd()}\nbacklog: ${backlogId}\n`);
	runTool("git", ["add", "--", "kb", ".nosedive/config.yaml"], bridge);
	gitCommit(bridge, "add sibling dive gate");

	const markerPath = join(bridge, "workspace", ".nosedive-ref");
	rmSync(markerPath);
	const sweep = run(["test"], bridge);
	assertOk(sweep, "backlog sweep failed");
	const ranDuringSweep = existsSync(logPath);
	rmSync(logPath, { force: true });

	// Bare dive rels survive from older record.dive versions; kind is the backstop.
	write(featPath, readFileSync(featPath, "utf8").replace("rel: working.dive", "rel: working"));
	write(markerPath, `id: ${diveId}\n`);
	gitCommitEmpty(worktree, "work");
	const landed = run(["land"], bridge);
	assertOk(landed, "first dive should land without running its sibling's gate");
	const ranDuringLand = existsSync(logPath);

	assert.equal(ranDuringSweep, false, "the backlog sweep descended into a sibling dive");
	assert.equal(ranDuringLand, false, "land descended into a sibling dive");
});

/**
 * The case the sibling-dive test above cannot reach: a dive that has already
 * closed. `land` and `bail` convert a dive to `kind: memo`, so the kind check is
 * blind to it, and the edge naming it is a bare `pending` with no `.dive` to
 * match. A live land walked straight through both and ran another feat's gate.
 *
 * The sibling feat is linked `child.feat` on purpose: it stays reachable, so
 * this fails for the edge into the closed dive and not for the feat being cut
 * off.
 */
test("a closed dive behind a bare rel does not gate another feat's land", () => {
	const gateId = "019fd471-0000-7000-8000-000000000050";
	const siblingFeatId = "019fd471-0000-7000-8000-000000000051";
	const closedDiveId = "019fd471-0000-7000-8000-000000000052";
	const logPath = join(tmp, "closed-dive-gate.json");
	const { bridge, worktree } = setup("closed-dive", [
		gate(gateId, "closed-dive-only", contextGate(logPath), undefined, { link: false }),
	]);
	write(
		join(bridge, "kb", `${closedDiveId}.md`),
		`---
kind: memo
id: ${closedDiveId}
name: sibling-feat.abcdef
gist: "Landed work -- bailed: closed, so no longer kind: dive"
scopes: []
meta:
  feat: ${siblingFeatId}
  diver: "someone@example.invalid"
links:
  - kb/${gateId}.md:
      rel: land.gate
---
`,
	);
	write(
		join(bridge, "kb", `${siblingFeatId}.md`),
		`---
kind: feat
id: ${siblingFeatId}
name: sibling-feat
gist: "Another feat under the same parent"
links:
  - kb/${closedDiveId}.md:
      rel: pending
---
`,
	);
	const featPath = join(bridge, "kb", `${featId}.md`);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			/^links:\n/m,
			`links:\n  - kb/${siblingFeatId}.md:\n      rel: child.feat\n`,
		),
	);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "add sibling feat with a closed dive");

	gitCommitEmpty(worktree, "work");
	assertOk(run(["land"], bridge), "land failed");
	assert.equal(
		existsSync(logPath),
		false,
		"land ran a gate declared by another feat's closed dive",
	);
});

/**
 * The two halves of the allowlist in one land: an ancestor reached by
 * `parent.feat` gates the work, and a feat reached only by the bare `child`
 * spelling does not. The narrowing is the point -- a rel meant to be traversed
 * says `.feat`, and a bridge still on the old spelling migrates rather than the
 * walk guessing.
 */
test("the walk follows .feat edges and not their bare spellings", () => {
	const ancestorGateId = "019fd471-0000-7000-8000-000000000060";
	const bareGateId = "019fd471-0000-7000-8000-000000000061";
	const ancestorId = "019fd471-0000-7000-8000-000000000062";
	const bareChildId = "019fd471-0000-7000-8000-000000000063";
	const ancestorLog = join(tmp, "ancestor-gate.json");
	const bareLog = join(tmp, "bare-child-gate.json");
	const { bridge, worktree } = setup("feat-edges", [
		gate(ancestorGateId, "ancestor", contextGate(ancestorLog), undefined, { link: false }),
		gate(bareGateId, "bare-child", contextGate(bareLog), undefined, { link: false }),
	]);
	for (const [id, name, gateId] of [
		[ancestorId, "ancestor-feat", ancestorGateId],
		[bareChildId, "bare-child-feat", bareGateId],
	]) {
		write(
			join(bridge, "kb", `${id}.md`),
			`---
kind: feat
id: ${id}
name: ${name}
gist: "Declares a gate"
links:
  - kb/${gateId}.md:
      rel: land.gate
---
`,
		);
	}
	const featPath = join(bridge, "kb", `${featId}.md`);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			/^links:\n/m,
			`links:\n  - kb/${ancestorId}.md:\n      rel: parent.feat\n  - kb/${bareChildId}.md:\n      rel: child\n`,
		),
	);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "add ancestor and bare-child feats");

	gitCommitEmpty(worktree, "work");
	assertOk(run(["land"], bridge), "land failed");
	assert.equal(existsSync(ancestorLog), true, "a parent.feat ancestor's gate did not run");
	assert.equal(existsSync(bareLog), false, "a feat reached by a bare child edge gated the land");
});

test("a legacy gate edge refuses rather than silently skipping the gate", () => {
	const { bridge, worktree } = setup("legacy-edge", [
		gate("019fd471-0000-7000-8000-000000000020", "builds", GATE_PASS),
	]);
	const featPath = join(bridge, "kb", `${featId}.md`);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace("rel: land.gate", `rel: ${legacyGateRel}`),
	);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "a legacy edge must block the land");
	assert.match(result.stderr, /obsolete; rename it to land\.gate/);
});

test("land runs a passing gate and publishes", () => {
	const { bridge, worktree } = setup("passing", [
		gate("019fd471-0000-7000-8000-00000000000a", "builds", GATE_PASS),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assertOk(result, "land with a passing gate should push");
	assert.match(result.stdout, /builds .*: passed/);
});

test("a gate with passing node:test tests passes", () => {
	const { bridge, worktree } = setup("node-test-passing", [
		gate("019fd471-0000-7000-8000-000000000032", "node-tests", GATE_TEST_PASS),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assertOk(result, "passing node:test tests should pass the gate");
	assert.match(result.stdout, /node-tests .*: passed/);
});

test("a failing gate refuses the land, pushes nothing, and reports into the dive", () => {
	const { bridge, worktree, diveId } = setup("failing", [
		gate("019fd471-0000-7000-8000-00000000000b", "builds", GATE_FAIL),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "land must refuse when a gate fails");
	assert.match(result.stderr, /gates did not pass; nothing was pushed/);

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.match(diveText, /## Land report /, "the report should land in the dive");
	assert.match(diveText, /FAILED \(exit 1\)/);
	assert.match(diveText, /gate says no/, "gate stderr should reach the next agent");
	assert.match(diveText, /^kind: dive$/m, "a refused land must leave the dive open");

	const branches = runTool(
		"git",
		["branch", "--all"],
		join(bridge, "workspace", "failing-repo"),
	).stdout;
	assert.doesNotMatch(branches, /work\/land-gates/, "nothing should have been pushed");
});

test("a gate with a failing node:test test fails", () => {
	const { bridge, worktree } = setup("node-test-failing", [
		gate("019fd471-0000-7000-8000-000000000033", "node-tests", GATE_TEST_FAIL),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "a failing node:test test must block the land");
	assert.match(result.stdout, /node-tests .*: FAILED/);
});

/**
 * The drain is bounded by silence, not elapsed time, so both directions have to
 * be pinned: a gate that keeps talking must outlive the limit, and one that goes
 * quiet must be cut. `NOSEDIVE_GATE_IDLE_MS` exists so these cost a second
 * rather than a minute; the default the runner ships is 30s.
 */
function withIdleLimit(ms, body) {
	const previous = process.env.NOSEDIVE_GATE_IDLE_MS;
	process.env.NOSEDIVE_GATE_IDLE_MS = String(ms);
	try {
		return body();
	} finally {
		if (previous === undefined) delete process.env.NOSEDIVE_GATE_IDLE_MS;
		else process.env.NOSEDIVE_GATE_IDLE_MS = previous;
	}
}

test("a node:test gate slower than the idle limit is not cut off", () => {
	const { bridge, worktree } = setup("node-test-slow", [
		gate("019fd471-0000-7000-8000-000000000034", "node-tests", GATE_TEST_TALKS_WHILE_SLOW),
	]);
	gitCommitEmpty(worktree, "work");
	const result = withIdleLimit(800, () => run(["land"], bridge));
	assertOk(result, "a suite that keeps talking must not be killed for being slow");
	assert.match(result.stdout, /node-tests .*: passed/);
});

test("a gate that goes silent with the loop open is failed, not left to hang", () => {
	const { bridge, worktree, diveId } = setup("hanging", [
		gate("019fd471-0000-7000-8000-000000000035", "hangs", GATE_HANGS_SILENTLY),
	]);
	gitCommitEmpty(worktree, "work");
	const result = withIdleLimit(800, () => run(["land"], bridge));
	assert.notEqual(result.status, 0, "a hung gate must fail the land");
	assert.match(result.stdout, /hangs .*: FAILED/);

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.match(
		diveText,
		/gate produced no output for 800ms; forcing exit/,
		"the report must say why the gate was cut, not just that it failed",
	);
});

test("test-is-flaky downgrades a failing gate to a warning", () => {
	const { bridge, worktree } = setup("flaky", [
		gate("019fd471-0000-7000-8000-00000000000c", "flaky-check", GATE_FAIL, {
			"test-is-flaky": "true",
		}),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assertOk(result, "a flaky gate failure must not block the land");
	assert.match(result.stdout, /flaky, not blocking/);
});

test("gates run tallest first, ties in discovery order", () => {
	const orderLog = join(tmp, "gate-order.log");
	write(orderLog, "");
	const { bridge, worktree } = setup("ordering", [
		gate("019fd471-0000-7000-8000-00000000000d", "height-5", orderGate(orderLog, "height-5"), {
			"gate-height": "5",
		}),
		// Two zero-height gates, declared in this order, must stay in it.
		gate("019fd471-0000-7000-8000-00000000000e", "zero-first", orderGate(orderLog, "zero-first")),
		gate("019fd471-0000-7000-8000-000000000019", "zero-second", orderGate(orderLog, "zero-second")),
		gate("019fd471-0000-7000-8000-00000000000f", "height-10", orderGate(orderLog, "height-10"), {
			"gate-height": "10",
		}),
	]);
	gitCommitEmpty(worktree, "work");
	assertOk(run(["land"], bridge), "land with ordered gates failed");
	assert.deepEqual(
		readFileSync(orderLog, "utf8").split(/\r?\n/).filter(Boolean),
		["height-10", "height-5", "zero-first", "zero-second"],
		"descending gate-height, discovery order breaking ties",
	);
});

test("a gate reached twice keeps its first-seen attributes and names the shadowed edge", () => {
	const gateId = "019fd471-0000-7000-8000-000000000018";
	const relayId = "019fd471-0000-7000-8000-00000000001a";
	const { bridge, worktree } = setup(
		"first-seen",
		[gate(gateId, "twice-linked", GATE_FAIL, { "test-is-flaky": "true" })],
		{
			extraDocs: [
				{
					id: relayId,
					body: `---
kind: feat
id: ${relayId}
name: relay
gist: "Links the same gate again, without the flaky marking"
links:
  - kb/${gateId}.md:
      rel: land.gate
---
`,
				},
			],
		},
	);
	// Link the relay after the gate so the gate's own (flaky) edge is seen first.
	const featPath = join(bridge, "kb", `${featId}.md`);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			/---\n$/,
			`  - kb/${relayId}.md:\n      rel: child.feat\n---\n`,
		),
	);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "add relay");
	gitCommitEmpty(worktree, "work");

	const result = run(["land"], bridge);
	assertOk(result, "first-seen flaky marking should still be in force");
	assert.match(result.stdout, /flaky, not blocking/);
	assert.match(result.stdout, new RegExp(`also linked by .*${relayId}`));
});

test("a doc named after its own domain still gates the land, and a missing test-script refuses it", () => {
	const namedForDomain = setup("bad-kind", [
		gate("019fd471-0000-7000-8000-000000000010", "not-a-gate", GATE_PASS, undefined, {
			kind: "banana",
		}),
	]);
	gitCommitEmpty(namedForDomain.worktree, "work");
	const domainResult = run(["land"], namedForDomain.bridge);
	assertOk(domainResult, "kind: banana with a working test-script should still gate the land");

	const noScript = setup("no-script", [
		{
			id: "019fd471-0000-7000-8000-000000000011",
			doc: gateDoc("019fd471-0000-7000-8000-000000000011", "scriptless", { script: null }),
		},
	]);
	gitCommitEmpty(noScript.worktree, "work");
	const scriptResult = run(["land"], noScript.bridge);
	assert.notEqual(scriptResult.status, 0);
	assert.match(scriptResult.stderr, /meta\.test-script is missing/);

	const missingFile = setup("missing-script", [
		{
			id: "019fd471-0000-7000-8000-000000000012",
			doc: gateDoc("019fd471-0000-7000-8000-000000000012", "absent"),
		},
	]);
	gitCommitEmpty(missingFile.worktree, "work");
	const fileResult = run(["land"], missingFile.bridge);
	assert.notEqual(fileResult.status, 0);
	assert.match(fileResult.stderr, /does not resolve to a file/);
	assert.match(fileResult.stderr, /create it/);
});

test("a gate runs from the bridge and reaches worktrees through ctx.repos", () => {
	const { bridge, worktree } = setup("live-head", [
		// Deliberately unscoped: where a gate runs must not depend on what it scopes.
		gate("019fd471-0000-7000-8000-000000000013", "echo-head", GATE_ECHO_HEAD),
	]);
	gitCommitEmpty(worktree, "work past the pin");
	const head = runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim();
	const result = run(["land"], bridge);
	assertOk(result, "land failed");
	assert.match(result.stdout, /cwd=.*live-head(?!-)/, "gates run from the bridge");
	assert.match(result.stdout, /root=workspace\/live-head-repo/, "root is bridge-relative");
	assert.match(result.stdout, new RegExp(head), "the gate should see the live worktree HEAD");
});

test("each gate receives its repo, feat, gate, and declaring doc ids", () => {
	const featGateId = "019fd471-0000-7000-8000-000000000036";
	const repoGateId = "019fd471-0000-7000-8000-000000000037";
	const featContextPath = join(tmp, "feat-gate-context.json");
	const repoContextPath = join(tmp, "repo-gate-context.json");
	const { bridge, worktree } = setup("gate-context", [
		gate(featGateId, "feat-context", contextGate(featContextPath)),
		gate(repoGateId, "repo-context", contextGate(repoContextPath), undefined, { link: false }),
	]);

	// The second edge belongs to the repo doc, not the feat. This deliberately
	// makes both per-gate principals differ in one run, which catches a context
	// serialized once outside the gate loop.
	const repoPath = join(bridge, "kb", `${repoId}.md`);
	write(
		repoPath,
		readFileSync(repoPath, "utf8").replace(
			"\n---\n",
			`\nlinks:\n  - kb/${repoGateId}.md:\n      rel: land.gate\n---\n`,
		),
	);
	gitCommitEmpty(worktree, "work");
	assertOk(run(["land"], bridge), "land with context-recording gates failed");

	const featContext = JSON.parse(readFileSync(featContextPath, "utf8"));
	const repoContext = JSON.parse(readFileSync(repoContextPath, "utf8"));
	for (const context of [featContext, repoContext]) {
		assert.deepEqual(context.repos["gate-context-repo"], {
			id: repoId,
			root: "workspace/gate-context-repo",
		});
		assert.equal(context.featId, featId);
	}
	assert.equal(featContext.gateId, featGateId);
	assert.equal(featContext.introducedById, featId);
	assert.notEqual(featContext.introducedById, featContext.gateId);
	assert.equal(repoContext.gateId, repoGateId);
	assert.equal(repoContext.introducedById, repoId);
	assert.notEqual(repoContext.introducedById, repoContext.gateId);
});

test("a gate resolves the dive and reads its own repo's scope entry", () => {
	const logPath = join(tmp, "scope-reading-gate.json");
	const { bridge, worktree } = setup("gate-resolve", [
		gate("019fd471-0000-7000-8000-000000000038", "reads-scope", scopeReadingGate(logPath)),
	]);
	gitCommitEmpty(worktree, "work");
	assertOk(run(["land"], bridge), "land with a resolving gate failed");

	// The whole point of handing a gate quids instead of documents: it walked
	// from its own repo id to the branch that repo's work goes to, reading the
	// kb live rather than being told in advance what it would want.
	assert.deepEqual(JSON.parse(readFileSync(logPath, "utf8")), {
		kind: "dive",
		repoId,
		workBranch: "work/land-gates.nosedive",
	});
});

test("ctx.resolve refuses a quid no document has", () => {
	const { bridge, worktree } = setup("gate-resolve-missing", [
		gate("019fd471-0000-7000-8000-000000000039", "resolves-nothing", GATE_RESOLVES_NOTHING),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	// Returning undefined would let the gate go on to pass, which is a gate
	// reporting "checked" about a document it never saw.
	assert.notEqual(result.status, 0, "a gate resolving nothing must not pass");
	assert.match(result.stdout + result.stderr, /ctx\.resolve found no kb document/);
});

test("a gate returning false fails the land", () => {
	const { bridge, worktree } = setup("returns-false", [
		gate("019fd471-0000-7000-8000-00000000001c", "returns-false", GATE_FALSE),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0, "returning false must block the land");
	assert.match(result.stdout, /returns-false .*: FAILED/);
});

test("a test-script with no run export is a gate failure", () => {
	const { bridge, worktree } = setup("no-run-export", [
		gate("019fd471-0000-7000-8000-00000000001d", "no-run", "export const nope = 1;\n"),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stdout, /gate module must export run\(ctx\)/);
});

test("a gate's output reaches the terminal while that gate is still running", async () => {
	const { bridge, worktree } = setup("streaming", [
		gate("019fd471-0000-7000-8000-000000000030", "talks-early", GATE_TALKS_THEN_STALLS),
	]);
	gitCommitEmpty(worktree, "work");

	const child = spawn(process.execPath, [cli, "land"], { cwd: bridge });
	let exited = false;
	let progressBeforeExit = false;
	let spokeBeforeExit = false;
	child.stderr.on("data", (chunk) => {
		const text = chunk.toString();
		if (!exited && text.includes("land: running 1 land gate")) progressBeforeExit = true;
		if (!exited && text.includes("gate speaking early")) spokeBeforeExit = true;
	});
	child.stdout.on("data", () => {});
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => {
			exited = true;
		});
		child.once("close", resolve);
	});

	assert.equal(
		progressBeforeExit,
		true,
		"the land progress line arrived only after land exited, so it was buffered",
	);
	assert.equal(
		spokeBeforeExit,
		true,
		"the gate's line arrived only after land exited, so it was buffered",
	);
});

test("a streamed gate is still recorded in the report byte for byte", () => {
	const { bridge, worktree, diveId } = setup("streamed-report", [
		gate("019fd471-0000-7000-8000-000000000031", "noisy", GATE_FAIL),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0);

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.match(diveText, /gate says no/, "streaming must not consume the captured text");
	assert.match(diveText, /FAILED \(exit 1\)/);
});

test("a slow gate does not stop the gates behind it from running", () => {
	const { bridge, worktree } = setup("slow-then-more", [
		gate("019fd471-0000-7000-8000-000000000014", "slow", GATE_SLOW, { "gate-height": "10" }),
		gate("019fd471-0000-7000-8000-000000000015", "after-slow", GATE_PASS, { "gate-height": "0" }),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land"], bridge);
	assertOk(result, "a slow gate must not refuse the land");
	assert.match(result.stdout, /slow gate finished/);
	assert.match(result.stdout, /after-slow .*: passed/, "every selected gate must run");
});

test("--clock is gone and is rejected rather than ignored", () => {
	const { bridge, worktree } = setup("clock-gone", [
		gate("019fd471-0000-7000-8000-000000000016", "builds", GATE_PASS),
	]);
	gitCommitEmpty(worktree, "work");
	const result = run(["land", "--clock", "300"], bridge);
	assert.notEqual(result.status, 0, "a removed option must not be silently accepted");
	assert.match(result.stderr, /unknown land option: --clock/);
});

test("unknown scalar link attributes are carried, non-scalar ones rejected", () => {
	const openKeys = setup("open-attrs", [
		gate("019fd471-0000-7000-8000-000000000017", "builds", GATE_PASS, {
			"gate-height": "2",
			"some-future-key": "tolerated",
		}),
	]);
	gitCommitEmpty(openKeys.worktree, "work");
	assertOk(run(["land"], openKeys.bridge), "an unknown scalar attribute must not break land");

	const gateIdWithList = "019fd471-0000-7000-8000-00000000001b";
	const listValue = setup("list-attr", [gate(gateIdWithList, "builds", GATE_PASS)]);
	// Added after setup: a non-scalar attribute is rejected everywhere kb docs
	// are read, so writing it up front would fail hydration rather than land.
	const featPath = join(listValue.bridge, "kb", `${featId}.md`);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			"      rel: land.gate\n",
			"      rel: land.gate\n      tags:\n        - a\n        - b\n",
		),
	);
	gitCommitEmpty(listValue.worktree, "work");
	const result = run(["land"], listValue.bridge);
	assert.notEqual(result.status, 0, "a non-scalar link attribute must be rejected");
	assert.match(result.stderr, /tags must be a scalar/);
});
