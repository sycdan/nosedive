import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("update-backlog");

const CURRENT = "019fc623-1000-7000-8000-000000000001";
const CHILD = "019fc623-1000-7000-8000-000000000002";
const GRANDCHILD = "019fc623-1000-7000-8000-000000000003";
const FUTURE = "019fc623-1000-7000-8000-000000000004";
const UNLINKED = "019fc623-1000-7000-8000-000000000005";
const FILED = "019fc623-1000-7000-8000-000000000006";
const DISCOVERED = "019fc623-1000-7000-8000-000000000007";
const UNAFFECTED = "019fc623-1000-7000-8000-000000000008";
const REPO = "019fc623-1000-7000-8000-0000000000a1";
const OTHER_REPO = "019fc623-1000-7000-8000-0000000000a2";

function backlogPath(bridge) {
	const id = /^backlog: (.+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	return join(bridge, "kb", `${id}.md`);
}

function seeded(name, options) {
	const bridge = createBridge(tmp, name, options);
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");
	return bridge;
}

/** A kb doc, written straight to disk so a test states the exact links it means. */
function doc(bridge, id, { kind = "feat", name, gist, scopes = [], links = [], body }) {
	const lines = ["---", `kind: ${kind}`, `id: ${id}`, `name: ${name}`, `gist: "${gist}"`];
	if (scopes.length > 0) lines.push("scopes:", ...scopes.map((repo) => `  - ${repo}`));
	if (links.length > 0) {
		lines.push(
			"links:",
			...links.flatMap(([target, rel]) => [`  - kb/${target}.md:`, `      rel: ${rel}`]),
		);
	}
	lines.push("---", "", `# ${body ?? name}`, "");
	write(join(bridge, "kb", `${id}.md`), lines.join("\n"));
}

function repoDoc(bridge, id, name) {
	write(
		join(bridge, "kb", `${id}.md`),
		`---\nkind: repo\nid: ${id}\nname: ${name}\ngist: "Test repo"\n---\n`,
	);
}

/** The memo's links, rewritten wholesale, with an optional scopes block. */
function backlogLinks(bridge, links, scopes) {
	const path = backlogPath(bridge);
	const text = readFileSync(path, "utf8");
	const frontmatter = [
		...text
			.split(/\r?\n/)
			.slice(1, text.split(/\r?\n/).indexOf("---", 1))
			.filter((line) => /^(kind|id|name|gist):/.test(line)),
		...(scopes ? scopes : []),
		...(links.length > 0
			? [
					"links:",
					...links.flatMap(([target, rel]) => [`  - kb/${target}.md:`, `      rel: ${rel}`]),
				]
			: []),
	];
	write(path, ["---", ...frontmatter, "---", "", "# Test Backlog", ""].join("\n"));
	return path;
}

/** A backlog with a Current root carrying one child and one grandchild, plus a Future root. */
function standardTree(bridge) {
	doc(bridge, CURRENT, {
		name: "current-root",
		gist: "The current root.",
		links: [[CHILD, "child.feat"]],
		body: "Current Root",
	});
	doc(bridge, CHILD, { name: "child-feat", gist: "A child.", body: "Child Feat" });
	doc(bridge, GRANDCHILD, {
		name: "grandchild-feat",
		gist: "A grandchild.",
		links: [[CHILD, "parent.feat"]],
		body: "Grandchild Feat",
	});
	doc(bridge, FUTURE, { name: "future-root", gist: "The future root.", body: "Future Root" });
	doc(bridge, UNLINKED, { name: "unlinked-feat", gist: "Linked by nobody.", body: "Unlinked" });
	return backlogLinks(bridge, [
		[FUTURE, "future.feat"],
		[CURRENT, "current.feat"],
	]);
}

test("the backlog renders one section per link predicate, and only linked work", () => {
	const bridge = seeded("update-backlog-sections");
	const path = standardTree(bridge);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	const memo = readFileSync(path, "utf8");

	assert.match(memo, /^# Test Backlog$/m, "the memo's own H1 was replaced");
	assert.deepEqual(
		[...memo.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
		["Current", "Future"],
		"sections come from link predicates, alphabetically",
	);
	assert.match(memo, /^- \[Current Root\]\(.*\.md\): The current root\.$/m);
	assert.match(memo, /^ {2}- \[Child Feat\]\(.*\.md\): A child\.$/m);
	assert.match(memo, /^ {4}- \[Grandchild Feat\]\(.*\.md\): A grandchild\.$/m);
	assert.match(memo, /^- \[Future Root\]\(.*\.md\): The future root\.$/m);
	assert.doesNotMatch(memo, /Linked by nobody/, "an unlinked feat must not be scanned in");
	assert.doesNotMatch(memo, /^### /m, "name slug chains no longer make grouping headings");
});

test("update-backlog never rewrites the memo's links", () => {
	const bridge = seeded("update-backlog-keeps-links");
	const path = standardTree(bridge);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	const memo = readFileSync(path, "utf8");
	assert.match(memo, /^ {6}rel: current\.feat$/m);
	assert.match(memo, /^ {6}rel: future\.feat$/m);
	assert.doesNotMatch(memo, /main-effort/, "the old derived rel must not come back");
});

test("update-backlog is idempotent", () => {
	const bridge = seeded("update-backlog-idempotent");
	const path = standardTree(bridge);

	assertOk(run(["update-backlog"], bridge), "first update-backlog failed");
	const first = readFileSync(path, "utf8");
	assertOk(run(["update-backlog"], bridge), "second update-backlog failed");
	assert.equal(readFileSync(path, "utf8"), first, "a second run changed the memo");
});

test("legacy main-effort and child rels render without being rewritten", () => {
	const bridge = seeded("update-backlog-legacy-rels");
	doc(bridge, CURRENT, {
		name: "legacy-root",
		gist: "A legacy root.",
		links: [[CHILD, "child"]],
		body: "Legacy Root",
	});
	doc(bridge, CHILD, { name: "legacy-child", gist: "A legacy child.", body: "Legacy Child" });
	const path = backlogLinks(bridge, [[CURRENT, "main-effort"]]);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	const memo = readFileSync(path, "utf8");
	assert.match(memo, /^## Main$/m, "the legacy -effort suffix still names a section");
	assert.match(memo, /^ {2}- \[Legacy Child\]\(.*\.md\): A legacy child\.$/m);
	assert.match(memo, /^ {6}rel: main-effort$/m, "a legacy rel must be left as the pilot wrote it");
});

test("a feat-like link renders a doc whose kind is not feat", () => {
	const bridge = seeded("update-backlog-any-kind");
	doc(bridge, CURRENT, {
		kind: "idea",
		name: "an-idea",
		gist: "Not a feat, but linked as work.",
		body: "An Idea",
	});
	const path = backlogLinks(bridge, [[CURRENT, "current.feat"]]);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	assert.match(readFileSync(path, "utf8"), /^- \[An Idea\]\(.*\.md\): Not a feat/m);
});

test("a backlog link naming a managed kind fails", () => {
	for (const kind of ["dive", "repo"]) {
		const bridge = seeded(`update-backlog-managed-${kind}`);
		doc(bridge, CURRENT, { kind, name: `a-${kind}`, gist: "Managed.", body: "Managed" });
		backlogLinks(bridge, [[CURRENT, "current.feat"]]);

		const result = run(["update-backlog"], bridge);
		assert.notEqual(result.status, 0, `a ${kind} target unexpectedly rendered`);
		assert.match(result.stderr, new RegExp(`names a kind: ${kind} doc, which is not work`));
		assert.match(result.stderr, new RegExp(CURRENT), "the failure must name the target");
	}
});

test("a managed kind pointing back at a feat is skipped, not reported", () => {
	const bridge = seeded("update-backlog-reverse-managed");
	doc(bridge, CURRENT, { name: "current-root", gist: "The root.", body: "Current Root" });
	doc(bridge, CHILD, {
		kind: "dive",
		name: "a-dive.current-root",
		gist: "A dive filed under its feat.",
		links: [[CURRENT, "parent-effort"]],
		body: "A Dive",
	});
	const path = backlogLinks(bridge, [[CURRENT, "current.feat"]]);

	assertOk(run(["update-backlog"], bridge), "a dive pointing up must not fail the render");
	assert.doesNotMatch(readFileSync(path, "utf8"), /A dive filed under its feat/);
});

test("a bare parent link is a backlog edge only from a feat", () => {
	const bridge = seeded("update-backlog-bare-parent");
	doc(bridge, CURRENT, { name: "current-root", gist: "The root.", body: "Current Root" });
	doc(bridge, CHILD, {
		name: "feat-child",
		gist: "A feat with a bare parent.",
		links: [[CURRENT, "parent"]],
		body: "Feat Child",
	});
	doc(bridge, GRANDCHILD, {
		kind: "memo",
		name: "memo-child",
		gist: "A memo with a bare parent.",
		links: [[CURRENT, "parent"]],
		body: "Memo Child",
	});
	const path = backlogLinks(bridge, [[CURRENT, "current.feat"]]);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	const memo = readFileSync(path, "utf8");
	assert.match(memo, /A feat with a bare parent/);
	assert.doesNotMatch(memo, /A memo with a bare parent/);
});

test("a parent's own links decide which named docs are children", () => {
	const bridge = seeded("update-backlog-parent-filing");
	doc(bridge, CURRENT, {
		name: "current-root",
		gist: "The root.",
		links: [
			[CHILD, "child.feat"],
			[FILED, "landed.feat"],
			[UNAFFECTED, "working"],
		],
		body: "Current Root",
	});
	doc(bridge, CHILD, { name: "forward-child", gist: "Forward child.", body: "Forward Child" });
	doc(bridge, FILED, {
		name: "filed-elsewhere",
		gist: "Filed elsewhere.",
		links: [[CURRENT, "parent.feat"]],
		body: "Filed Elsewhere",
	});
	doc(bridge, DISCOVERED, {
		name: "reverse-child",
		gist: "Reverse child.",
		links: [[CURRENT, "parent.feat"]],
		body: "Reverse Child",
	});
	doc(bridge, UNAFFECTED, {
		name: "unrelated-filing",
		gist: "Unrelated filing.",
		body: "Unrelated Filing",
	});
	const path = backlogLinks(bridge, [[CURRENT, "current.feat"]]);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	const memo = readFileSync(path, "utf8");
	assert.match(memo, /Forward child\./, "a forward child.feat link must still render");
	assert.match(memo, /Reverse child\./, "an unnamed doc must still be reverse-discovered");
	assert.doesNotMatch(memo, /Filed elsewhere\./, "the parent's non-child filing must win");
	assert.doesNotMatch(
		memo,
		/Unrelated filing\./,
		"a named doc without a parent claim stays absent",
	);
});

test("a backlog link naming an unknown doc fails", () => {
	const bridge = seeded("update-backlog-unknown");
	backlogLinks(bridge, [[UNLINKED, "current.feat"]]);

	const result = run(["update-backlog"], bridge);
	assert.notEqual(result.status, 0, "an unresolvable link unexpectedly rendered");
	assert.match(result.stderr, /names an unknown doc/);
});

test("a cycle in child links fails naming the loop", () => {
	const bridge = seeded("update-backlog-cycle");
	doc(bridge, CURRENT, {
		name: "loop-a",
		gist: "A.",
		links: [[CHILD, "child.feat"]],
		body: "Loop A",
	});
	doc(bridge, CHILD, {
		name: "loop-b",
		gist: "B.",
		links: [[CURRENT, "child.feat"]],
		body: "Loop B",
	});
	backlogLinks(bridge, [[CURRENT, "current.feat"]]);

	const result = run(["update-backlog"], bridge);
	assert.notEqual(result.status, 0, "a child-link cycle unexpectedly rendered");
	assert.match(result.stderr, /backlog child links form a cycle/);
	assert.match(result.stderr, new RegExp(`${CURRENT} -> ${CHILD} -> ${CURRENT}`));
});

test("a memo linking no work renders its heading and says so", () => {
	const bridge = seeded("update-backlog-empty");
	const path = backlogLinks(bridge, []);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	const memo = readFileSync(path, "utf8");
	assert.match(memo, /^# Test Backlog$/m);
	assert.match(memo, /^The backlog links no work\.$/m);
	assert.doesNotMatch(memo, /^## /m);
});

test("scopes follow the rendered tree and keep what was written on them", () => {
	const bridge = seeded("update-backlog-scopes");
	repoDoc(bridge, REPO, "apple");
	repoDoc(bridge, OTHER_REPO, "zebra");
	doc(bridge, CURRENT, {
		name: "scoped-root",
		gist: "Scoped.",
		scopes: [REPO, OTHER_REPO],
		body: "Scoped Root",
	});
	// The kept repo carries a note; the stale one is justified by no rendered doc.
	const path = backlogLinks(
		bridge,
		[[CURRENT, "current.feat"]],
		["scopes:", `  - ${REPO}:`, '      note: "keep me"', `  - ${UNLINKED}`],
	);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	const memo = readFileSync(path, "utf8");
	assert.match(
		memo,
		new RegExp(`^scopes:\n  - ${REPO}:\n      note: "keep me"\n  - ${OTHER_REPO}$`, "m"),
		"a surviving scope keeps its keys, a new one is written bare, a stale one goes",
	);
	assert.doesNotMatch(memo, new RegExp(UNLINKED));
});

test("scopes survive a render that derives none", () => {
	const bridge = seeded("update-backlog-scopes-empty");
	const path = standardTree(bridge);
	write(
		path,
		readFileSync(path, "utf8").replace(
			/^links:$/m,
			`scopes:\n  - ${REPO}:\n      note: "hand written"\nlinks:`,
		),
	);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	assert.match(readFileSync(path, "utf8"), /^ {6}note: "hand written"$/m);
});

test("--inject adds a doc under its own section", () => {
	const bridge = seeded("update-backlog-inject");
	const path = standardTree(bridge);

	const injected = run(["update-backlog", "--inject", UNLINKED], bridge);
	assertOk(injected, "--inject failed");
	assert.match(injected.stdout, new RegExp(`Injected kb/${UNLINKED}\\.md`));
	const memo = readFileSync(path, "utf8");
	assert.match(memo, /^ {6}rel: injected\.feat$/m);
	assert.match(memo, /^## Injected$/m);
	assert.match(memo, /^- \[Unlinked\]\(.*\.md\): Linked by nobody\.$/m);
});

test("--inject is a no-op for a doc the memo already links as work", () => {
	const bridge = seeded("update-backlog-inject-twice");
	const path = standardTree(bridge);

	const repeated = run(["update-backlog", "--inject", CURRENT], bridge);
	assertOk(repeated, "--inject on an already-linked doc failed");
	assert.match(repeated.stdout, new RegExp(`Already on the backlog: kb/${CURRENT}\\.md`));
	const memo = readFileSync(path, "utf8");
	assert.doesNotMatch(memo, /injected\.feat/, "an existing rel must not be rewritten");
	assert.equal([...memo.matchAll(new RegExp(`kb/${CURRENT}\\.md`, "g"))].length, 1);
});

test("--inject writes nothing when any ref fails to resolve", () => {
	const bridge = seeded("update-backlog-inject-unresolvable");
	const path = standardTree(bridge);
	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	const before = readFileSync(path, "utf8");

	const result = run(
		["update-backlog", "--inject", UNLINKED, "--inject", CHILD, "--inject", REPO],
		bridge,
	);
	assert.notEqual(result.status, 0, "an unresolvable --inject unexpectedly succeeded");
	assert.equal(readFileSync(path, "utf8"), before, "a failed --inject wrote to the memo");
});

test("--inject refuses a managed kind", () => {
	const bridge = seeded("update-backlog-inject-managed");
	standardTree(bridge);
	doc(bridge, REPO, { kind: "dive", name: "a-dive", gist: "Managed.", body: "A Dive" });

	const result = run(["update-backlog", "--inject", REPO], bridge);
	assert.notEqual(result.status, 0, "--inject accepted a dive");
	assert.match(result.stderr, /--inject names a kind: dive doc, which is not work/);
});

test("a pitch under a linked parent reaches the backlog with no further step", () => {
	const bridge = seeded("update-backlog-pitch-parent");
	const path = standardTree(bridge);

	assertOk(
		run(["pitch", "Pitched under the root.", "--name", "pitched", "--parent", CURRENT], bridge),
		"pitch failed",
	);
	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	assert.match(
		readFileSync(path, "utf8"),
		/^ {2}- \[Pitched\]\(.*\.md\): Pitched under the root\.$/m,
	);
});

test("a pitch with no parent says how to reach the backlog", () => {
	const bridge = seeded("update-backlog-pitch-orphan");
	const path = standardTree(bridge);

	const pitched = run(["pitch", "Nobody's child.", "--name", "orphan"], bridge);
	assertOk(pitched, "pitch failed");
	const hint = /nosedive update-backlog --inject ([0-9a-f-]+)$/m.exec(pitched.stdout);
	assert.ok(hint, `pitch did not point at --inject:\n${pitched.stdout}`);

	assertOk(run(["update-backlog"], bridge), "update-backlog failed");
	assert.doesNotMatch(readFileSync(path, "utf8"), /Nobody's child/);
	assertOk(run(["update-backlog", "--inject", hint[1]], bridge), "the printed --inject failed");
	assert.match(readFileSync(path, "utf8"), /^- \[Orphan\]\(.*\.md\): Nobody's child\.$/m);
});
