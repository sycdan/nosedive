import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, gitCommit, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("test");
const passId = "019fe100-0000-7000-8000-000000000001";
const failId = "019fe100-0000-7000-8000-000000000002";
const wrongKindId = "019fe100-0000-7000-8000-000000000003";
const backlogId = "019fe100-0000-7000-8000-000000000004";

function gateDoc(id, kind = "assertion", { script = `kb/artifacts/${id}.mjs` } = {}) {
	const meta = script === null ? "meta:\n" : `meta:\n  test-script: ${script}\n`;
	return `---
kind: ${kind}
id: ${id}
name: ${id}
gist: "Run gate fixture"
${meta}---
`;
}

function setup(name, options) {
	const bridge = createBridge(tmp, name, options);
	write(join(bridge, "kb", `${passId}.md`), gateDoc(passId));
	write(
		join(bridge, "kb", "artifacts", `${passId}.mjs`),
		'export function run() { console.log("passed gate"); }\n',
	);
	write(join(bridge, "kb", `${failId}.md`), gateDoc(failId));
	write(
		join(bridge, "kb", "artifacts", `${failId}.mjs`),
		'export function run() { console.error("failed gate"); return false; }\n',
	);
	write(join(bridge, "kb", `${wrongKindId}.md`), gateDoc(wrongKindId, "memo", { script: null }));
	return bridge;
}

test("test runs a passing gate", () => {
	const result = run(["test", passId], setup("passing"));
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "passed gate\n");
});

test("test returns a failing gate status", () => {
	const result = run(["test", failId], setup("failing"));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /failed gate/);
});

test("test clearly rejects an unknown id", () => {
	const result = run(["test", "019fe100-0000-7000-8000-000000000099"], setup("unknown"));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /gate not found: 019fe100-0000-7000-8000-000000000099/);
});

test("test clearly rejects a document with no test-script", () => {
	const result = run(["test", wrongKindId], setup("wrong-kind"));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /meta\.test-script is missing/);
});

const diveId = "019fe100-0000-7000-8000-000000000010";
const featId = "019fe100-0000-7000-8000-000000000011";
const featGateId = "019fe100-0000-7000-8000-000000000012";

function gateLink(id) {
	return `  - kb/${id}.md:\n      rel: test.gate\n`;
}

function linkCount(text, id) {
	return text.split(`- kb/${id}.md:`).length - 1;
}

function reportCount(text) {
	return text.split("## Test report ").length - 1;
}

function mintedDives(bridge) {
	return readdirSync(join(bridge, "kb"))
		.filter((name) => name.endsWith(".md") && name !== `${diveId}.md`)
		.map((name) => ({ name, text: readFileSync(join(bridge, "kb", name), "utf8") }))
		.filter(({ text }) => /^kind: dive$/m.test(text));
}

/**
 * A bridge whose dive claims one gate directly and whose feat claims another,
 * which is the only shape that can tell the two selections apart: with no
 * arguments only the dive's gate may run, and `--full` must reach both.
 */
function setupDive(name, { diveGates = [passId], featGates = [featGateId] } = {}) {
	const bridge = setup(name, { backlog: backlogId });
	write(join(bridge, "kb", `${featGateId}.md`), gateDoc(featGateId));
	write(
		join(bridge, "kb", "artifacts", `${featGateId}.mjs`),
		'export function run() { console.log("feat gate ran"); }\n',
	);
	write(
		join(bridge, "kb", `${featId}.md`),
		`---\nkind: feat\nid: ${featId}\nname: test-selection.nosedive\ngist: "Selection fixture"\n` +
			`links:\n${featGates.map(gateLink).join("")}---\n`,
	);
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---\nkind: memo\nid: ${backlogId}\nname: backlog.test\ngist: "Backlog fixture"\n` +
			`links:\n  - kb/${featId}.md:\n      rel: feat\n---\n`,
	);
	write(
		join(bridge, "kb", `${diveId}.md`),
		`---\nkind: dive\nid: ${diveId}\nname: test-selection.nosedive.abc123\ngist: "Selection fixture"\n` +
			`scopes: []\nmeta:\n  effort: ${featId}\n` +
			`links:\n${diveGates.map(gateLink).join("")}---\n\n# Dive\n`,
	);
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${diveId}\n`);
	return bridge;
}

test("test with no arguments runs the dive's own gates and nothing else", () => {
	const result = run(["test"], setupDive("dive-scoped"));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /passed gate/);
	assert.doesNotMatch(result.stdout, /feat gate ran/, "the feat's gate is not dive-resident");
});

test("test --full reaches test gates the dive does not claim itself", () => {
	const result = run(["test", "--full"], setupDive("full-walk"));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /passed gate/);
	assert.match(result.stdout, /feat gate ran/);
	assert.match(result.stderr, /2 gate\(s\) in .*: 2 passed, 0 failed/);
});

test("a failing dive gate records a report and link without changing its declaration", () => {
	const bridge = setupDive("failing-dive-gate");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	const gatePath = join(bridge, "kb", `${failId}.md`);
	const gateBefore = readFileSync(gatePath, "utf8");
	const result = run(["test", failId], bridge);

	assert.equal(result.status, 1);
	const diveText = readFileSync(divePath, "utf8");
	assert.match(diveText, /^## Test report \d{4}-\d{2}-\d{2}T.*Z$/m);
	assert.match(diveText, new RegExp(`kb/${failId}\\.md:\\n      rel: test\\.gate`));
	assert.equal(readFileSync(gatePath, "utf8"), gateBefore, "the gate declaration must not move");
});

test("a linked failing gate is not linked twice while every failure records a report", () => {
	const bridge = setupDive("repeat-failure", { diveGates: [failId] });
	const divePath = join(bridge, "kb", `${diveId}.md`);
	write(divePath, readFileSync(divePath, "utf8").replace("rel: test.gate", "rel: related"));

	assert.equal(run(["test", failId], bridge).status, 1);
	assert.equal(run(["test", failId], bridge).status, 1);
	const diveText = readFileSync(divePath, "utf8");
	assert.equal(linkCount(diveText, failId), 1);
	assert.match(diveText, /rel: related/);
	assert.equal(reportCount(diveText), 2);
});

test("a flaky failing gate leaves no link or report", () => {
	const bridge = setupDive("flaky-failure", { diveGates: [], featGates: [failId] });
	const featPath = join(bridge, "kb", `${featId}.md`);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			"rel: test.gate",
			"rel: test.gate\n      test-is-flaky: true",
		),
	);
	const divePath = join(bridge, "kb", `${diveId}.md`);
	const diveBefore = readFileSync(divePath, "utf8");

	const result = run(["test", "--full"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(divePath, "utf8"), diveBefore);
});

/**
 * The case that makes the flaky rule load-bearing. A flaky failure on its own
 * never reaches the attachment at all -- `outcome.failed` already excludes it,
 * so both callers skip the whole branch. Only a run carrying a blocking failure
 * *and* a flaky one gets there with both in hand, and the flaky gate must not
 * come along.
 */
test("a flaky failure alongside a blocking one attaches only the blocking gate", () => {
	const bridge = setupDive("mixed-failure", { diveGates: [failId] });
	write(
		join(bridge, "kb", "artifacts", `${featGateId}.mjs`),
		'export function run() { console.error("flaky feat gate failed"); return false; }\n',
	);
	const featPath = join(bridge, "kb", `${featId}.md`);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			"rel: test.gate",
			"rel: test.gate\n      test-is-flaky: true",
		),
	);

	const result = run(["test", "--full"], bridge);
	assert.equal(result.status, 1, "the blocking failure must still fail the run");
	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.equal(linkCount(diveText, failId), 1);
	assert.equal(linkCount(diveText, featGateId), 0, "a flaky failure is not the dive's to fix");
});

test("a passing run leaves the dive byte-identical", () => {
	const bridge = setupDive("passing-unchanged");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	const before = readFileSync(divePath, "utf8");

	assert.equal(run(["test"], bridge).status, 0);
	assert.equal(readFileSync(divePath, "utf8"), before);
});

test("a --full failure on the feat gate attaches it to the dive", () => {
	const bridge = setupDive("full-failure", { featGates: [failId] });
	const result = run(["test", "--full"], bridge);

	assert.equal(result.status, 1);
	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.equal(linkCount(diveText, failId), 1);
	assert.equal(reportCount(diveText), 1);
});

test("test runs every named gate in order and rejects the removed land argument", () => {
	const bridge = setupDive("many-gates");
	const both = run(["test", featGateId, passId], bridge);
	assert.equal(both.status, 0, both.stderr);
	assert.ok(both.stdout.indexOf("feat gate ran") < both.stdout.indexOf("passed gate"));
	assert.match(both.stderr, /2 gate\(s\) in .*: 2 passed, 0 failed/);

	const removed = run(["test", "land"], bridge);
	assert.equal(removed.status, 1);
	assert.match(removed.stderr, /unrecognised test argument: land/);
});

test("test without an active dive sweeps test.gate links from the backlog memo", () => {
	const bridge = setupDive("no-dive");
	rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });
	const result = run(["test"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /feat gate ran/);
	assert.doesNotMatch(result.stdout, /passed gate/, "the dive is not reachable from the backlog");
});

test("a blocking backlog failure mints one unclaimed linked dive and backlog still renders", () => {
	const bridge = setupDive("mint-failure", { featGates: [failId] });
	const markerPath = join(bridge, "workspace", ".nosedive-ref");
	rmSync(markerPath, { force: true });

	assert.equal(run(["test"], bridge).status, 1);
	assert.equal(run(["test"], bridge).status, 1);
	const dives = mintedDives(bridge);
	assert.equal(dives.length, 1, "the second sweep must deduplicate the failure");
	assert.match(dives[0].text, new RegExp(`^  effort: ${featId}$`, "m"));
	assert.match(dives[0].text, /^  diver: null$/m);
	assert.match(dives[0].text, /^## Brief$/m);
	assert.match(dives[0].text, new RegExp(`kb/${failId}\\.md:\n      rel: test\\.gate`));
	assert.match(dives[0].text, /failed gate/);
	assert.equal(existsSync(markerPath), false, "minting must not activate the dive");
	const featText = readFileSync(join(bridge, "kb", `${featId}.md`), "utf8");
	/**
	 * Either spelling. `record.dive` writes `pending` for an unclaimed dive
	 * today, and `planned.dive` is where the dive rel lifecycle
	 * (kb/01a003fb-2f63-...) takes it. The claim here is that the feat gained an
	 * edge to the minted dive, which holds under both -- pinning the qualifier
	 * would make this test fail on a change it has no opinion about.
	 */
	assert.match(
		featText,
		new RegExp(
			`kb/${dives[0].name.replace(".md", "")}\\.md:\n      rel: (?:pending|planned\\.dive)`,
		),
	);
	assert.equal(run(["update-backlog"], bridge).status, 0);
});

test("a bailed minted dive no longer blocks a fresh mint", () => {
	const bridge = setupDive("mint-after-bail", { featGates: [failId] });
	rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });
	assert.equal(run(["test"], bridge).status, 1);
	const first = mintedDives(bridge)[0];
	write(join(bridge, "kb", first.name), first.text.replace("kind: dive", "kind: memo"));

	assert.equal(run(["test"], bridge).status, 1);
	assert.equal(mintedDives(bridge).length, 1, "the finished memo must permit one fresh dive");
});

test("gate ownership reads meta.feat first and still supports meta.effort", () => {
	for (const field of ["feat", "effort"]) {
		const bridge = setupDive(`mint-${field}`, { featGates: [] });
		const ownerId = field === "feat" ? passId : wrongKindId;
		write(
			join(bridge, "kb", `${ownerId}.md`),
			`---\nkind: memo\nid: ${ownerId}\nname: ${field}-owner\ngist: "Owner fixture"\nmeta:\n  ${field}: ${featId}\nlinks:\n${gateLink(failId)}---\n`,
		);
		const backlogPath = join(bridge, "kb", `${backlogId}.md`);
		write(
			backlogPath,
			readFileSync(backlogPath, "utf8").replace(
				"links:\n",
				`links:\n  - kb/${ownerId}.md:\n      rel: related\n`,
			),
		);
		rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });

		assert.equal(run(["test"], bridge).status, 1);
		const minted = mintedDives(bridge);
		assert.equal(minted.length, 1, `meta.${field} did not resolve a feat to mint against`);
		assert.match(minted[0].text, new RegExp(`^  effort: ${featId}$`, "m"));
	}
});

test("a backlog gate with no resolvable feat reports why and mints nothing", () => {
	const bridge = setupDive("mint-no-feat", { featGates: [] });
	const backlogPath = join(bridge, "kb", `${backlogId}.md`);
	write(
		backlogPath,
		readFileSync(backlogPath, "utf8").replace("links:\n", `links:\n${gateLink(failId)}`),
	);
	rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });

	const result = run(["test"], bridge);
	assert.equal(result.status, 1);
	assert.match(
		result.stderr,
		new RegExp(`${failId}.*${backlogId}\\.md.*test\\.gate needs a feat in context to mint against`),
	);
	assert.equal(mintedDives(bridge).length, 0);
});

test("test still runs a named gate without any dive on deck", () => {
	const bridge = setupDive("named-without-dive");
	rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });
	const result = run(["test", passId], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "passed gate\n");
});

test("a named failing gate without a dive does not mint", () => {
	const bridge = setupDive("named-failure-without-dive");
	rmSync(join(bridge, "workspace", ".nosedive-ref"), { force: true });
	assert.equal(run(["test", failId], bridge).status, 1);
	assert.equal(mintedDives(bridge).length, 0);
});

test("every gate runs even after one fails, and all failures are reported once", () => {
	const failB = "019fe100-0000-7000-8000-000000000013";
	const failC = "019fe100-0000-7000-8000-000000000014";
	const bridge = setupDive("collect-failures", { diveGates: [failId, failB, failC] });
	for (const id of [failB, failC]) {
		write(join(bridge, "kb", `${id}.md`), gateDoc(id));
		write(
			join(bridge, "kb", "artifacts", `${id}.mjs`),
			`export function run() { console.error("failed ${id}"); return false; }\n`,
		);
	}

	const result = run(["test"], bridge);
	assert.equal(result.status, 1, "a failing set must exit 1");
	assert.match(result.stderr, /3 gate\(s\) in .*: 0 passed, 3 failed/);
	for (const id of [failId, failB, failC]) {
		assert.equal(
			result.stderr.split(`FAILED  ${id}`).length - 1,
			1,
			`${id} should be named exactly once in the summary`,
		);
	}
});

test("a dive gate needs no gate-height", () => {
	const bridge = setupDive("no-height");
	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.doesNotMatch(diveText, /gate-height/, "the fixture must not set one");
	assert.equal(run(["test"], bridge).status, 0);
});

test("a dive that links no gates is reported rather than called green", () => {
	const result = run(["test"], setupDive("no-gates", { diveGates: [] }));
	assert.notEqual(result.status, 0, "zero gates must never be success");
	assert.match(result.stderr, /selects no test\.gate gates/);
	assert.match(result.stderr, /test --full/);
});

/**
 * The skip has to be visible, because a gate that loops over `ctx.repos` and
 * asserts something per repo reports success having checked nothing when the
 * workspace is empty. Naming it is not an error and must not change the exit
 * code -- a bridge legitimately carries repo docs it has never hydrated.
 */
const scopedRepoId = "019fe510-0000-7000-8000-0000000000f1";
const unscopedRepoId = "019fe510-0000-7000-8000-0000000000f2";

function addRepo(bridge, id, name) {
	const source = join(tmp, `${name}-source`);
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, "base");
	write(
		join(bridge, "kb", `${id}.md`),
		`---\nkind: repo\nid: ${id}\nname: ${name}\ngist: "Repo fixture."\n` +
			`meta:\n  path: workspace/${name}\n  trunk: main\n  remotes:\n    local: ${source.replaceAll("\\", "/")}\n---\n`,
	);
	return { source, worktree: join(bridge, "workspace", name) };
}

function setGateScript(bridge, id, message) {
	write(
		join(bridge, "kb", "artifacts", `${id}.mjs`),
		`export function run(ctx) { console.log(${JSON.stringify(message)} + JSON.stringify(ctx.repos)); }\n`,
	);
}

test("a gate inherits its declaring feat scopes and hydrates the named repo", () => {
	const bridge = setupDive("inherited-scope", { diveGates: [], featGates: [featGateId] });
	addRepo(bridge, scopedRepoId, "inherited-repo");
	write(
		join(bridge, "kb", `${featId}.md`),
		readFileSync(join(bridge, "kb", `${featId}.md`), "utf8").replace(
			"links:\n",
			`scopes:\n  - ${scopedRepoId}\nlinks:\n`,
		),
	);
	setGateScript(bridge, featGateId, "inherited ");

	const result = run(["test", "--full"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /inherited .*inherited-repo/);
	assert.match(result.stderr, /hydrated repo inherited-repo at [0-9a-f]{40}/);
});

test("a gate's own scopes override the declaring feat scopes", () => {
	const bridge = setupDive("gate-scope", { diveGates: [], featGates: [featGateId] });
	addRepo(bridge, scopedRepoId, "feat-repo");
	addRepo(bridge, unscopedRepoId, "gate-repo");
	write(
		join(bridge, "kb", `${featId}.md`),
		readFileSync(join(bridge, "kb", `${featId}.md`), "utf8").replace(
			"links:\n",
			`scopes:\n  - ${scopedRepoId}\nlinks:\n`,
		),
	);
	write(
		join(bridge, "kb", `${featGateId}.md`),
		gateDoc(featGateId).replace("gist:", `scopes:\n  - ${unscopedRepoId}\ngist:`),
	);
	setGateScript(bridge, featGateId, "override ");

	const result = run(["test", "--full"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /gate-repo/);
	assert.doesNotMatch(result.stdout, /feat-repo/);
	assert.equal(existsSync(join(bridge, "workspace", "feat-repo")), false);
});

test("an explicit empty declaring scope set leaves ctx.repos empty and says so", () => {
	const bridge = setupDive("empty-scope", { diveGates: [], featGates: [featGateId] });
	addRepo(bridge, scopedRepoId, "empty-feat-repo");
	write(
		join(bridge, "kb", `${featId}.md`),
		readFileSync(join(bridge, "kb", `${featId}.md`), "utf8").replace(
			"links:\n",
			`scopes:\n  - ${scopedRepoId}\nlinks:\n`,
		),
	);
	write(
		join(bridge, "kb", `${featGateId}.md`),
		gateDoc(featGateId).replace("gist:", "scopes: []\ngist:"),
	);
	setGateScript(bridge, featGateId, "empty ");

	const result = run(["test", "--full"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /empty \{\}/);
	assert.match(result.stderr, /resolves no repo scopes; ctx\.repos is empty/);
});

test("a repo no selected gate scopes is not hydrated", () => {
	const bridge = setupDive("unscoped-repo", { diveGates: [], featGates: [featGateId] });
	addRepo(bridge, unscopedRepoId, "unscoped-repo");

	const result = run(["test", "--full"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(bridge, "workspace", "unscoped-repo")), false);
});

test("an existing scoped worktree at another commit is reported and never moved", () => {
	const bridge = setupDive("existing-other-commit", { diveGates: [], featGates: [featGateId] });
	const repo = addRepo(bridge, scopedRepoId, "existing-repo");
	const pinned = runTool("git", ["rev-parse", "HEAD"], repo.source).stdout.trim();
	write(
		join(bridge, "kb", `${featId}.md`),
		readFileSync(join(bridge, "kb", `${featId}.md`), "utf8").replace(
			"links:\n",
			`scopes:\n  - ${scopedRepoId}:\n      ref: ${pinned}\nlinks:\n`,
		),
	);
	setGateScript(bridge, featGateId, "existing ");

	assert.equal(run(["test", "--full"], bridge).status, 0);
	write(join(repo.worktree, "README.md"), "ahead\n");
	runTool("git", ["add", "README.md"], repo.worktree);
	gitCommit(repo.worktree, "ahead");
	const ahead = runTool("git", ["rev-parse", "HEAD"], repo.worktree).stdout.trim();
	const result = run(["test", "--full"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		new RegExp(`is at ${ahead}, not declared commit ${pinned}; leaving it unchanged`),
	);
	assert.equal(runTool("git", ["rev-parse", "HEAD"], repo.worktree).stdout.trim(), ahead);
});
