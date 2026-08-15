import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("list-dives");

const DECK_ID = "019fe510-0000-7000-8000-000000000001";
const TOP_FEAT_ID = "019fe510-0000-7000-8000-000000000002";
const CHILD_FEAT_ID = "019fe510-0000-7000-8000-000000000003";
const OFF_DECK_FEAT_ID = "019fe510-0000-7000-8000-000000000004";
const PENDING_DIVE_ID = "019fe510-0000-7000-8000-0000000000a1";
const DEEP_DIVE_ID = "019fe510-0000-7000-8000-0000000000a2";
const WORKING_DIVE_ID = "019fe510-0000-7000-8000-0000000000a3";
const LANDED_DIVE_ID = "019fe510-0000-7000-8000-0000000000a4";
const OFF_DECK_DIVE_ID = "019fe510-0000-7000-8000-0000000000a5";
const UNLINKED_DIVE_ID = "019fe510-0000-7000-8000-0000000000a6";

function link(id, rel) {
	return [`  - kb/${id}.md:`, `      rel: ${rel}`];
}

function writeDoc(bridge, kind, id, name, links = [], meta = []) {
	write(
		join(bridge, "kb", `${id}.md`),
		[
			"---",
			`kind: ${kind}`,
			`id: ${id}`,
			`name: ${name}`,
			`gist: "Fixture ${name}."`,
			...(meta.length > 0 ? ["meta:", ...meta] : []),
			...(links.length > 0 ? ["links:", ...links] : []),
			"---",
			"",
			`# ${name}`,
			"",
		].join("\n"),
	);
}

function writeDive(bridge, id, name, { feat, diver } = {}) {
	writeDoc(
		bridge,
		"dive",
		id,
		name,
		[],
		[...(feat ? [`  effort: ${feat}`] : []), `  diver: ${diver ?? "null"}`],
	);
}

/**
 * One bridge, one dive graph, read three ways. The scopes only mean anything
 * relative to each other -- a dive off the deck has to be absent from the deck
 * listing and present in the kb listing, or neither scope is doing its job.
 */
function bridgeWithDives(name) {
	const bridge = createBridge(tmp, name, { backlog: DECK_ID });
	writeDoc(bridge, "memo", DECK_ID, "main.deck", link(TOP_FEAT_ID, "main-effort.feat"));
	writeDoc(bridge, "feat", TOP_FEAT_ID, "top-fixture", [
		...link(CHILD_FEAT_ID, "child"),
		...link(PENDING_DIVE_ID, "pending.dive"),
		...link(WORKING_DIVE_ID, "working"),
		...link(LANDED_DIVE_ID, "landed.dive"),
	]);
	writeDoc(bridge, "feat", CHILD_FEAT_ID, "child-fixture", [...link(DEEP_DIVE_ID, "pending")]);
	writeDoc(bridge, "feat", OFF_DECK_FEAT_ID, "off-deck-fixture", [
		...link(OFF_DECK_DIVE_ID, "pending"),
	]);

	writeDive(bridge, PENDING_DIVE_ID, "pending-dive", { feat: TOP_FEAT_ID });
	writeDive(bridge, DEEP_DIVE_ID, "deep-dive", { feat: CHILD_FEAT_ID });
	writeDive(bridge, WORKING_DIVE_ID, "working-dive", {
		feat: TOP_FEAT_ID,
		diver: "dive-pilot@example.invalid",
	});
	writeDive(bridge, LANDED_DIVE_ID, "landed-dive", { feat: TOP_FEAT_ID });
	writeDive(bridge, OFF_DECK_DIVE_ID, "off-deck-dive", { feat: OFF_DECK_FEAT_ID });
	writeDive(bridge, UNLINKED_DIVE_ID, "unlinked-dive");
	return bridge;
}

test("list-dives with no scope lists every dive in the kb", () => {
	const bridge = bridgeWithDives("kb-scope-bridge");

	const listed = run(["list-dives"], bridge);
	assertOk(listed, "bare list-dives failed");
	assert.match(listed.stdout, /^Scope: kb$/m);
	for (const name of [
		"pending-dive",
		"deep-dive",
		"working-dive",
		"landed-dive",
		"off-deck-dive",
		"unlinked-dive",
	]) {
		assert.match(listed.stdout, new RegExp(name));
	}

	// No edge to read in this scope, so meta.diver is what splits the sections.
	const pending = listed.stdout.indexOf("Pending:");
	const working = listed.stdout.indexOf("Working:");
	assert.ok(listed.stdout.indexOf("unlinked-dive") > pending);
	assert.ok(listed.stdout.indexOf("unlinked-dive") < working);
	assert.ok(listed.stdout.indexOf("working-dive") > working);

	// The tags are the "what they still need" half of the listing.
	assert.match(listed.stdout, /- \[unlinked-dive\]\(kb\/.+\.md\) needs=brief,scopes,diver/);
	assert.match(listed.stdout, /- \[working-dive\]\(kb\/.+\.md\) diver=dive-pilot@example\.invalid/);
});

test("list-dives on a deck lists every dive its feat tree reaches", () => {
	const bridge = bridgeWithDives("deck-scope-bridge");

	const listed = run(["list-dives", "main.deck"], bridge);
	assertOk(listed, "deck-scoped list-dives failed");
	assert.match(listed.stdout, /^Scope: deck main\.deck$/m);
	assert.match(listed.stdout, /- \[pending-dive\]\(kb\/.+\.md\) rel=pending\.dive/);
	// Reached two feats down, and by a bare rel.
	assert.match(listed.stdout, /- \[deep-dive\]\(kb\/.+\.md\) rel=pending/);
	assert.match(listed.stdout, /- \[working-dive\]\(kb\/.+\.md\) rel=working/);
	for (const absent of ["off-deck-dive", "unlinked-dive"]) {
		assert.doesNotMatch(listed.stdout, new RegExp(absent));
	}

	// A landed dive is linked but has no live phase, so it is history.
	assert.doesNotMatch(listed.stdout, /landed-dive/);
	const historical = run(["list-dives", "main.deck", "--include-historical"], bridge);
	assertOk(historical, "deck-scoped list-dives --include-historical failed");
	assert.match(historical.stdout, /^Historical:$/m);
	assert.match(historical.stdout, /- \[landed-dive\]\(kb\/.+\.md\) rel=landed\.dive/);
});

test("list-dives on a feat lists that feat only, and warns about drift", () => {
	const bridge = bridgeWithDives("feat-scope-bridge");
	// Names the feat without being linked from it, and held: the drift warning.
	writeDive(bridge, "019fe510-0000-7000-8000-0000000000b1", "drifted-dive", {
		feat: TOP_FEAT_ID,
		diver: "other-pilot@example.invalid",
	});

	const listed = run(["list-dives", "top-fixture"], bridge);
	assertOk(listed, "feat-scoped list-dives failed");
	assert.match(listed.stdout, /^Scope: feat top-fixture$/m);
	assert.match(listed.stdout, /- \[pending-dive\]\(kb\/.+\.md\) rel=pending\.dive/);
	// A child feat is its own scope, not part of this one.
	assert.doesNotMatch(listed.stdout, /deep-dive/);
	assert.match(
		listed.stdout,
		/Warnings:\n {2}- held dive 019fe510-0000-7000-8000-0000000000b1 points at top-fixture but is not linked/,
	);
});

test("list-dives buckets legacy and lifecycle dive rels identically", () => {
	const legacy = bridgeWithDives("legacy-dive-rels-bridge");
	const lifecycle = bridgeWithDives("lifecycle-dive-rels-bridge");
	const lifecycleFeatPath = join(lifecycle, "kb", `${TOP_FEAT_ID}.md`);
	const lifecycleChildPath = join(lifecycle, "kb", `${CHILD_FEAT_ID}.md`);
	write(
		lifecycleFeatPath,
		readFileSync(lifecycleFeatPath, "utf8")
			.replace("rel: pending.dive", "rel: planned.dive")
			.replace("rel: working", "rel: jumped.dive"),
	);
	write(
		lifecycleChildPath,
		readFileSync(lifecycleChildPath, "utf8").replace("rel: pending", "rel: planned.dive"),
	);
	const lifecycleWorkingPath = join(lifecycle, "kb", `${WORKING_DIVE_ID}.md`);
	const legacyWorkingPath = join(legacy, "kb", `${WORKING_DIVE_ID}.md`);
	write(
		legacyWorkingPath,
		readFileSync(legacyWorkingPath, "utf8").replace(/^  diver: .+$/m, "  diver: null"),
	);
	write(
		lifecycleWorkingPath,
		readFileSync(lifecycleWorkingPath, "utf8").replace(/^  diver: .+$/m, "  diver: null"),
	);

	const legacyResult = JSON.parse(run(["list-dives", "main.deck", "--json"], legacy).stdout);
	const lifecycleResult = JSON.parse(run(["list-dives", "main.deck", "--json"], lifecycle).stdout);
	assert.deepEqual(
		lifecycleResult.pending.map((dive) => dive.id),
		legacyResult.pending.map((dive) => dive.id),
	);
	assert.deepEqual(
		lifecycleResult.working.map((dive) => dive.id),
		legacyResult.working.map((dive) => dive.id),
	);
});

test("list-dives --json reports the scope and its sections", () => {
	const bridge = bridgeWithDives("json-scope-bridge");

	const listed = run(["list-dives", "main.deck", "--json"], bridge);
	assertOk(listed, "list-dives --json failed");
	const result = JSON.parse(listed.stdout);
	assert.equal(result.scope, "deck main.deck");
	assert.deepEqual(
		result.pending.map((dive) => dive.name),
		["pending-dive", "deep-dive"],
	);
	assert.deepEqual(
		result.working.map((dive) => dive.name),
		["working-dive"],
	);
	assert.deepEqual(result.historical, [], "historical stays out unless asked for");
});

test("list-dives refuses a ref that is neither a feat nor a deck", () => {
	const bridge = bridgeWithDives("bad-scope-bridge");

	const listed = run(["list-dives", "pending-dive"], bridge);
	assert.notEqual(listed.status, 0, "list-dives on a dive unexpectedly succeeded");
	assert.match(listed.stderr, /list-dives needs a feat or a deck: pending-dive is a dive/);
});
