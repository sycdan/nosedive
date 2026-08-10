import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
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
const effortId = "019fd471-0000-7000-8000-000000000002";
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
const GATE_SLOW =
	'export function run() {\n\tAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);\n\tconsole.error("slow gate finished");\n}\n';
const orderGate = (logPath, name) =>
	`import { appendFileSync } from "node:fs";\n\nexport function run() {\n\tappendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${name}\n`)});\n}\n`;
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
 * @param linkFrom "dive" | "effort" -- which doc carries the land.gate edges
 */
function setup(name, gates = [], { linkFrom = "effort", extraDocs = [] } = {}) {
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
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: land-gates.nosedive
gist: "Gate test effort"
scopes:
  - ${repoId}
${linkFrom === "effort" && gateLinks ? `links:\n${gateLinks}\n` : ""}---
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

test("a legacy gate edge refuses rather than silently skipping the gate", () => {
	const { bridge, worktree } = setup("legacy-edge", [
		gate("019fd471-0000-7000-8000-000000000020", "builds", GATE_PASS),
	]);
	const effortPath = join(bridge, "kb", `${effortId}.md`);
	write(
		effortPath,
		readFileSync(effortPath, "utf8").replace("rel: land.gate", `rel: ${legacyGateRel}`),
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
kind: memo
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
	const effortPath = join(bridge, "kb", `${effortId}.md`);
	write(
		effortPath,
		readFileSync(effortPath, "utf8").replace(
			/---\n$/,
			`  - kb/${relayId}.md:\n      rel: uses\n---\n`,
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

test("an ineligible kind and a missing test-script both refuse the land", () => {
	const badKind = setup("bad-kind", [
		gate("019fd471-0000-7000-8000-000000000010", "not-a-gate", GATE_PASS, undefined, {
			kind: "memo",
		}),
	]);
	gitCommitEmpty(badKind.worktree, "work");
	const kindResult = run(["land"], badKind.bridge);
	assert.notEqual(kindResult.status, 0);
	assert.match(kindResult.stderr, /points at kind: memo/);

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
	const effortPath = join(listValue.bridge, "kb", `${effortId}.md`);
	write(
		effortPath,
		readFileSync(effortPath, "utf8").replace(
			"      rel: land.gate\n",
			"      rel: land.gate\n      tags:\n        - a\n        - b\n",
		),
	);
	gitCommitEmpty(listValue.worktree, "work");
	const result = run(["land"], listValue.bridge);
	assert.notEqual(result.status, 0, "a non-scalar link attribute must be rejected");
	assert.match(result.stderr, /tags must be a scalar/);
});
