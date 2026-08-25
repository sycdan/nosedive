import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, runTool, write } from "../test-helpers.mjs";

const tmp = createTmp("record-gate");

/** A bridge with one feat, returned with the feat's id and path. */
function setup(name) {
	const bridge = createBridge(tmp, name);
	const pitched = run(["record.feat", "Keep the thing honest.", "--name", "honesty"], bridge);
	assertOk(pitched, "record.feat failed");
	const featPath = join(bridge, /^Recorded (.+)$/m.exec(pitched.stdout)[1]);
	const featText = readFileSync(featPath, "utf8");
	return { bridge, featPath, featId: /^id: (\S+)$/m.exec(featText)[1] };
}

function recordedGateId(stdout) {
	const match = /^Recorded kb[/\\]([0-9a-f-]+)\.md$/m.exec(stdout);
	assert.ok(match, `record.gate did not report a written doc:\n${stdout}`);
	return match[1];
}

test("record.gate mints a gate, its stub, and the feat link, and the gate fails as unimplemented", () => {
	const { bridge, featPath } = setup("mints");

	const recorded = run(
		["record.gate", "The command surface stays in step with the docs.", "--feat", "honesty"],
		bridge,
	);
	assertOk(recorded, "record.gate failed");
	const gateId = recordedGateId(recorded.stdout);

	const doc = readFileSync(join(bridge, "kb", `${gateId}.md`), "utf8");
	assert.match(doc, /^kind: gate$/m);
	assert.match(doc, /^gist: "The command surface stays in step with the docs\."$/m);
	assert.match(doc, /^name: the-command-surface-stays-in-step-with$/m);
	assert.match(doc, new RegExp(`^  test-script: kb/artifacts/${gateId}\\.mjs$`, "m"));
	// An absent scopes key inherits the declaring doc's; an empty one would say
	// the opposite and pin the gate to no repo at all.
	assert.doesNotMatch(doc, /^scopes:/m, "a minted gate must write no scopes key");

	assert.ok(
		existsSync(join(bridge, "kb", "artifacts", `${gateId}.mjs`)),
		"the stub script must be written beside the doc",
	);
	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`- kb/${gateId}\\.md:\\n      rel: test\\.gate`),
		"the feat must declare the gate",
	);

	// The whole point of writing the stub: the gate runs, and it is red.
	const ran = run(["test", gateId], bridge);
	assert.notEqual(ran.status, 0, "a freshly minted gate must fail");
	assert.match(ran.stderr, new RegExp(`gate ${gateId} is unimplemented`));
});

test("record.gate puts the name on the doc and height and flakiness on the link", () => {
	const { bridge, featPath } = setup("attributes");

	const recorded = run(
		[
			"record.gate",
			"No import crosses a layer boundary.",
			"--feat",
			"honesty",
			"--name",
			"layer-map-holds",
			"--height",
			"3",
			"--flaky",
		],
		bridge,
	);
	assertOk(recorded, "record.gate with attributes failed");
	const gateId = recordedGateId(recorded.stdout);

	const doc = readFileSync(join(bridge, "kb", `${gateId}.md`), "utf8");
	assert.match(doc, /^name: layer-map-holds$/m);
	assert.match(doc, /^# Layer Map Holds$/m);
	// Height and flakiness belong to the edge, not the gate: one prover can be a
	// test.gate here and a land.gate elsewhere, at a different height.
	assert.doesNotMatch(doc, /gate-height|test-is-flaky/);
	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(
			`- kb/${gateId}\\.md:\\n      rel: test\\.gate\\n      gate-height: 3\\n      test-is-flaky: true`,
		),
	);
});

test("--name still wins over a gist that would otherwise be derived", () => {
	const { bridge } = setup("name-wins");

	const recorded = run(
		[
			"record.gate",
			"This gist would derive a totally different slug.",
			"--feat",
			"honesty",
			"--name",
			"picked-by-hand",
		],
		bridge,
	);
	assertOk(recorded, "record.gate with an explicit name over a derivable gist failed");
	const gateId = recordedGateId(recorded.stdout);
	const doc = readFileSync(join(bridge, "kb", `${gateId}.md`), "utf8");
	assert.match(doc, /^name: picked-by-hand$/m);
});

test("record.gate falls back to a timestamp name when the gist yields no usable slug", () => {
	const { bridge } = setup("gate-fallback");

	const recorded = run(["record.gate", "!!! --- ???", "--feat", "honesty"], bridge);
	assertOk(recorded, "record.gate with an unslugable gist failed");
	const gateId = recordedGateId(recorded.stdout);
	const doc = readFileSync(join(bridge, "kb", `${gateId}.md`), "utf8");
	assert.match(doc, /^name: new-gate-\d{4}-\d{2}-\d{2}-\d{6}$/m);
});

test("record.gate falls back to a timestamp name when a derived slug collides on the feat", () => {
	const { bridge } = setup("gate-collision");

	const first = run(["record.gate", "Builds cleanly.", "--feat", "honesty"], bridge);
	assertOk(first, "first record.gate failed");
	const firstDoc = readFileSync(join(bridge, "kb", `${recordedGateId(first.stdout)}.md`), "utf8");
	assert.match(firstDoc, /^name: builds-cleanly$/m);

	const second = run(["record.gate", "Builds cleanly.", "--feat", "honesty"], bridge);
	assertOk(second, "second record.gate failed");
	const secondDoc = readFileSync(join(bridge, "kb", `${recordedGateId(second.stdout)}.md`), "utf8");
	assert.match(secondDoc, /^name: new-gate-\d{4}-\d{2}-\d{2}-\d{6}$/m);
});

test("record.gate defaults --action to test.gate", () => {
	const { bridge, featPath } = setup("action-default");

	const recorded = run(["record.gate", "Defaults stay test.gate.", "--feat", "honesty"], bridge);
	assertOk(recorded, "record.gate failed");
	const gateId = recordedGateId(recorded.stdout);

	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`- kb/${gateId}\\.md:\\n      rel: test\\.gate`),
		"the default must declare test.gate",
	);
	assert.match(recorded.stdout, /Declared test\.gate on/);
	assert.match(recorded.stdout, new RegExp(`Run it with: nosedive test ${gateId}`));
});

test("--action land declares land.gate on the feat, blocking nosedive land", () => {
	const { bridge, featPath } = setup("action-land");

	const recorded = run(
		["record.gate", "Publication is conditional on this.", "--feat", "honesty", "--action", "land"],
		bridge,
	);
	assertOk(recorded, "record.gate --action land failed");
	const gateId = recordedGateId(recorded.stdout);

	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`- kb/${gateId}\\.md:\\n      rel: land\\.gate`),
		"--action land must declare land.gate",
	);
	assert.match(recorded.stdout, /Declared land\.gate on/);
	assert.match(recorded.stdout, /blocks nosedive land/);
	assert.match(recorded.stdout, new RegExp(`Run it with: nosedive test ${gateId}`));

	// namedGate resolves a gate by uuid without filtering on rel, so the land
	// gate runs the same way a test gate would.
	const ran = run(["test", gateId], bridge);
	assert.notEqual(ran.status, 0, "a freshly minted gate must fail");
	assert.match(ran.stderr, new RegExp(`gate ${gateId} is unimplemented`));
});

test("--action=land also works, and an unknown --action value is refused", () => {
	const { bridge, featPath } = setup("action-equals-and-refusal");

	const recorded = run(
		["record.gate", "Equals form.", "--feat", "honesty", "--action=land"],
		bridge,
	);
	assertOk(recorded, "record.gate --action=land failed");
	const gateId = recordedGateId(recorded.stdout);
	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`- kb/${gateId}\\.md:\\n      rel: land\\.gate`),
	);

	const badAction = run(
		["record.gate", "Bad action.", "--feat", "honesty", "--action", "publish"],
		bridge,
	);
	assert.notEqual(badAction.status, 0);
	assert.match(badAction.stderr, /--action must be test or land: publish/);
});

test("record.gate refuses what it cannot mint a runnable gate from", () => {
	const { bridge, featId } = setup("refusals");
	const noFeat = run(["record.gate", "Unowned."], bridge);
	assert.notEqual(noFeat.status, 0);
	assert.match(noFeat.stderr, /record\.gate requires --feat/);

	const noGist = run(["record.gate", "--feat", "honesty"], bridge);
	assert.notEqual(noGist.status, 0);
	assert.match(noGist.stderr, /record\.gate requires --gist/);

	const badName = run(
		["record.gate", "Fine gist.", "--feat", "honesty", "--name", "Not A Slug"],
		bridge,
	);
	assert.notEqual(badName.status, 0);
	assert.match(badName.stderr, /--name must be kebab-case/);

	const badHeight = run(
		["record.gate", "Fine gist.", "--feat", "honesty", "--height", "tall"],
		bridge,
	);
	assert.notEqual(badHeight.status, 0);
	assert.match(badHeight.stderr, /--height must be an integer/);

	// A failing test.gate mints work against the feat that declared it, so a gate
	// declared on anything else leaves its own failure with nowhere to go.
	const recorded = run(["record.gate", "Fine gist.", "--feat", featId], bridge);
	assertOk(recorded, "record.gate on the feat's own id failed");
	const gateId = recordedGateId(recorded.stdout);
	const onAGate = run(["record.gate", "Nested.", "--feat", gateId], bridge);
	assert.notEqual(onAGate.status, 0);
	assert.match(onAGate.stderr, /--feat does not resolve to a kind: feat doc/);
});

test("record.gate commits the gate, its script, and the feat that declares it", () => {
	const { bridge } = setup("commits");
	const recorded = run(["record.gate", "The goodbye note exists.", "--feat", "honesty"], bridge);
	assertOk(recorded, "record.gate failed");
	const gateId = recordedGateId(recorded.stdout);
	assert.ok(
		recorded.stdout.includes("Committed gate(the-goodbye-note-exists): created"),
		recorded.stdout,
	);

	// The script matters as much as the doc: a gate whose script never reached
	// the clone resolves to nothing and hard-fails whatever selects it.
	const committed = runTool("git", ["show", "--pretty=format:", "--name-only", "HEAD"], bridge);
	const files = committed.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	assert.ok(files.includes(`kb/${gateId}.md`), committed.stdout);
	assert.ok(files.includes(`kb/artifacts/${gateId}.mjs`), committed.stdout);
	assert.equal(files.length, 3, `the feat should be the third file: ${committed.stdout}`);
});

test("a bare record.gate publishes the check a pilot wrote into the stub", () => {
	const { bridge } = setup("publish-script");
	const recorded = run(["record.gate", "The check is hand written.", "--feat", "honesty"], bridge);
	assertOk(recorded, "record.gate failed");
	const gateId = recordedGateId(recorded.stdout);
	const script = `kb/artifacts/${gateId}.mjs`;

	// The stub is the one file of a gate a pilot writes, and nothing stages it:
	// land stashes what is unstaged, so an unpublished check reaches no clone.
	write(
		join(bridge, script),
		'export function run() {\n\tconsole.error("hand written check");\n}\n',
	);

	const published = run(["record.gate", gateId], bridge);
	assertOk(published, "a bare record.gate failed");
	assert.match(published.stdout, /Updated /);
	assert.match(runTool("git", ["show", `HEAD:${script}`], bridge).stdout, /hand written check/);
	assert.equal(runTool("git", ["status", "--porcelain", "--", script], bridge).stdout, "");

	const head = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();
	const again = run(["record.gate", gateId], bridge);
	assertOk(again, "a second bare record.gate failed");
	assert.match(again.stdout, /Already published/);
	assert.equal(
		runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(),
		head,
		"publishing an unchanged gate should commit nothing",
	);
});
