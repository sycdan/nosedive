import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, runGit, write } from "../test-helpers.mjs";

const tmp = createTmp("find");
const minted = run(["mint", "18"], tmp);
assertOk(minted, "mint failed");
const [
	BACKLOG,
	FEAT,
	OLD,
	RECENT,
	NAMED,
	WRONG_REL,
	REFERENCE_ONLY,
	REPO_A,
	REPO_B,
	NOTE_A,
	NOTE_B,
	UNCOMMITTED,
	GATE_INHERITS,
	GATE_EMPTY,
	TODO,
	BUG,
	H1_ONLY,
	UNTYPED,
] = minted.stdout.trim().split(/\r?\n/);

function link(id, rel) {
	return [`  - kb/${id}.md:`, `      rel: ${rel}`];
}

/** `scopes: []` is not the same as no `scopes:` key, so the fixture can write either. */
function scopeLines(scopes) {
	if (scopes === undefined) return [];
	if (scopes.length === 0) return ["scopes: []"];
	return ["scopes:", ...scopes.map((scope) => `  - ${scope}`)];
}

function doc(bridge, kind, id, name, gist, { links = [], scopes, body = "" } = {}) {
	write(
		join(bridge, "kb", `${id}.md`),
		[
			"---",
			...(kind === undefined ? [] : [`kind: ${kind}`]),
			`id: ${id}`,
			`name: ${name}`,
			`gist: "${gist}"`,
			...scopeLines(scopes),
			...(links.length ? ["links:", ...links] : []),
			"---",
			"",
			body,
		].join("\n"),
	);
}

/**
 * Through `runGit`, not a bare spawn: the pre-push hook runs this suite from
 * inside git's own environment, and an inherited GIT_DIR commits to the repo
 * being pushed instead of to the fixture bridge.
 */
function commitAt(bridge, message, date) {
	runGit(["commit", "-m", message], bridge, {
		env: {
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.invalid",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.invalid",
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
		},
	});
}

function fixture(name) {
	const bridge = createBridge(tmp, name, { backlog: BACKLOG });
	doc(bridge, "memo", BACKLOG, "backlog", "Backlog", {
		links: link(FEAT, "root.feat"),
		scopes: [REPO_A, REPO_B],
	});
	doc(bridge, "feat", FEAT, "nested", "Nested", {
		scopes: [REPO_A],
		links: [
			...link(RECENT, "evidence.note"),
			...link(RECENT, "duplicate.note"),
			...link(OLD, "old.note"),
			...link(NAMED, "named.note"),
			...link(WRONG_REL, "wrong.repo"),
			...link(GATE_INHERITS, "land.gate"),
			...link(GATE_EMPTY, "land.gate"),
			...link(TODO, "todo.note"),
			...link(BUG, "bug.note"),
			...link(H1_ONLY, "h1.note"),
			...link(UNTYPED, "untyped.note"),
		],
	});
	doc(bridge, "repo", REPO_A, "alpha", "Alpha Repo", { links: link(NOTE_A, "todo.note") });
	doc(bridge, "repo", REPO_B, "beta", "Beta Repo", { links: link(NOTE_B, "todo.note") });
	doc(bridge, "note", OLD, "old", "Exact Search Term", {
		links: link(REFERENCE_ONLY, "related.note"),
		scopes: [REPO_A],
	});
	doc(bridge, "note", WRONG_REL, "wrong", "Exact Search Term");
	doc(bridge, "note", REFERENCE_ONLY, "reference-only", "Exact Search Term");
	runGit(["add", "."], bridge);
	commitAt(bridge, "old docs", "2020-01-01T00:00:00Z");
	doc(bridge, "note", RECENT, "recent", "Exact Search Term", {
		scopes: [REPO_A],
		body: "# Written By Hand\n",
	});
	doc(bridge, "note", NAMED, "exact-search-term", "Other gist", { scopes: [REPO_A] });
	doc(bridge, "note", NOTE_A, "alpha-note", "Alpha repo todo", { scopes: [REPO_A] });
	doc(bridge, "note", NOTE_B, "beta-note", "Beta repo todo", { scopes: [REPO_B] });
	doc(bridge, "gate", GATE_INHERITS, "inherits-scopes", "Gate that omits scopes");
	doc(bridge, "gate", GATE_EMPTY, "declares-no-scopes", "Gate that declares no scopes", {
		scopes: [],
	});
	doc(bridge, "todo", TODO, "todo-find", "Search todo kind", { scopes: [REPO_A] });
	doc(bridge, "bug", BUG, "bug-find", "Search bug kind", { scopes: [REPO_A] });
	doc(bridge, "note", H1_ONLY, "ordinary-name", "Ordinary summary", {
		scopes: [REPO_A],
		body: "# H1-only discovery\n",
	});
	doc(bridge, undefined, UNTYPED, "untyped", "Untyped document", { scopes: [REPO_A] });
	runGit(["add", "."], bridge);
	commitAt(bridge, "recent docs", new Date().toISOString());
	return bridge;
}

test("find walks nested backlog links, filters rel roles, deduplicates, and matches slug substrings", () => {
	const bridge = fixture("matches");
	const result = run(["find", "note", "search"], bridge);
	assertOk(result, "find failed");
	assert.equal(result.stdout.match(new RegExp(RECENT, "g"))?.length, 1);
	assert.match(result.stdout, new RegExp(NAMED));
	assert.doesNotMatch(result.stdout, new RegExp(WRONG_REL));
	assert.doesNotMatch(result.stdout, new RegExp(REFERENCE_ONLY));
});

test("find renders kind-grouped markdown links, and says so when nothing matches", () => {
	const bridge = fixture("render");
	const result = run(["find", "note", "search"], bridge);
	assertOk(result, "find failed");
	assert.match(result.stdout, /^## Notes\n\n### bug\n\n/);
	assert.match(result.stdout, /\n### note\n\n/);
	assert.ok(
		result.stdout.includes(`- [Written By Hand](kb/${RECENT}.md): Exact Search Term`),
		`link text should be the document's H1:\n${result.stdout}`,
	);
	assert.ok(
		result.stdout.includes(`- [Exact Search Term](kb/${NAMED}.md): Other gist`),
		`link text should fall back to the document name:\n${result.stdout}`,
	);
	const empty = run(["find", "note", "no-such-term"], bridge);
	assertOk(empty, "empty find failed");
	assert.equal(empty.stdout, "## Notes\n\nNo matches.\n");
});

test("find filters repeatable --kind values, matches H1s, and groups by kind", () => {
	const bridge = fixture("kind");
	const todo = run(["find", "note", "--kind", "todo"], bridge);
	assertOk(todo, "kind-only find failed");
	assert.match(todo.stdout, new RegExp(TODO));
	assert.doesNotMatch(todo.stdout, new RegExp(BUG));
	assert.doesNotMatch(todo.stdout, new RegExp(NOTE_A));

	const twoKinds = run(["find", "note", "search", "--kind", "todo", "--kind", "bug"], bridge);
	assertOk(twoKinds, "multi-kind find failed");
	assert.match(twoKinds.stdout, new RegExp(TODO));
	assert.match(twoKinds.stdout, new RegExp(BUG));
	assert.doesNotMatch(twoKinds.stdout, new RegExp(RECENT));

	const absent = run(["find", "note", "--kind", "does-not-exist"], bridge);
	assertOk(absent, "absent kind find failed");
	assert.equal(absent.stdout, "## Notes\n\nNo matches.\n");

	const h1 = run(["find", "note", "h1-only"], bridge);
	assertOk(h1, "H1 find failed");
	assert.match(h1.stdout, new RegExp(H1_ONLY));

	const grouped = run(["find", "note"], bridge);
	assertOk(grouped, "grouped find failed");
	for (const kind of ["bug", "note", "todo", "unclassified"])
		assert.match(grouped.stdout, new RegExp(`### ${kind}\\n\\n`));
	assert.ok(
		grouped.stdout.indexOf("### bug") < grouped.stdout.indexOf("### note") &&
			grouped.stdout.indexOf("### note") < grouped.stdout.indexOf("### todo") &&
			grouped.stdout.indexOf("### todo") < grouped.stdout.indexOf("### unclassified"),
		`kinds should sort alphabetically:\n${grouped.stdout}`,
	);
});

test("find walks the repos the backlog scopes", () => {
	const bridge = fixture("repos");
	const result = run(["find", "note"], bridge);
	assertOk(result, "find list failed");
	assert.match(result.stdout, new RegExp(NOTE_A));
	assert.match(result.stdout, new RegExp(NOTE_B));
	assert.match(result.stdout, new RegExp(RECENT));
	assert.doesNotMatch(result.stdout, new RegExp(WRONG_REL));
	assert.doesNotMatch(result.stdout, new RegExp(REFERENCE_ONLY));
});

test("find repo lists the repos the backlog scopes, and --scope narrows to the named one", () => {
	const bridge = fixture("repo-role");
	const all = run(["find", "repo"], bridge);
	assertOk(all, "repo find failed");
	assert.match(all.stdout, new RegExp(REPO_A));
	assert.match(all.stdout, new RegExp(REPO_B));

	// A repo declares no `scopes:` of its own, so the trailing scope filter reads
	// the backlog's -- which names every repo. Narrowing has to happen where the
	// repos are seeded, or `--scope beta` would answer with alpha as well.
	const beta = run(["find", "repo", "--scope", "beta"], bridge);
	assertOk(beta, "scoped repo find failed");
	assert.match(beta.stdout, new RegExp(REPO_B));
	assert.doesNotMatch(beta.stdout, new RegExp(REPO_A));
});

test("find --scope keeps documents scoping any named repo, by name or id", () => {
	const bridge = fixture("scope");
	const beta = run(["find", "note", "--scope", "beta"], bridge);
	assertOk(beta, "scoped find failed");
	assert.match(beta.stdout, new RegExp(NOTE_B));
	assert.doesNotMatch(beta.stdout, new RegExp(NOTE_A));
	assert.doesNotMatch(beta.stdout, new RegExp(RECENT));

	const both = run(["find", "note", "--scope", "alpha", "--scope", REPO_B], bridge);
	assertOk(both, "multi-scoped find failed");
	assert.match(both.stdout, new RegExp(NOTE_A));
	assert.match(both.stdout, new RegExp(NOTE_B));
	assert.match(both.stdout, new RegExp(RECENT));
});

test("find --scope resolves inherited scopes", () => {
	const bridge = fixture("inherited-scopes");
	const listed = run(["find", "gate"], bridge);
	assertOk(listed, "gate find failed");
	assert.match(listed.stdout, new RegExp(GATE_INHERITS));
	assert.match(listed.stdout, new RegExp(GATE_EMPTY));

	// The gate omitting `scopes:` answers for the feat that declares it; the one
	// declaring `scopes: []` has said it answers for no repo, and means it.
	const scoped = run(["find", "gate", "--scope", "alpha"], bridge);
	assertOk(scoped, "scoped gate find failed");
	assert.match(scoped.stdout, new RegExp(GATE_INHERITS));
	assert.doesNotMatch(scoped.stdout, new RegExp(GATE_EMPTY));
});

test("find windows on age only where the pilot asked for a window", () => {
	const bridge = fixture("age");
	// No flags is no window. A ceiling nobody named would answer a narrower
	// question than the one asked, and say nothing about having narrowed it.
	const unwindowed = run(["find", "note"], bridge);
	assertOk(unwindowed, "unwindowed find failed");
	assert.match(unwindowed.stdout, new RegExp(RECENT));
	assert.match(unwindowed.stdout, new RegExp(OLD));

	const older = run(["find", "note", "--min-age", "1d"], bridge);
	assertOk(older, "min-age find failed");
	assert.match(older.stdout, new RegExp(OLD));
	assert.doesNotMatch(older.stdout, new RegExp(RECENT));

	const newer = run(["find", "note", "--max-age", "1d"], bridge);
	assertOk(newer, "max-age find failed");
	assert.match(newer.stdout, new RegExp(RECENT));
	assert.doesNotMatch(newer.stdout, new RegExp(OLD));
});

test("find treats a document Git has never seen as brand new", () => {
	const bridge = fixture("uncommitted");
	doc(bridge, "note", UNCOMMITTED, "uncommitted", "Uncommitted Term", { scopes: [REPO_A] });
	doc(bridge, "feat", FEAT, "nested", "Nested", { links: link(UNCOMMITTED, "fresh.note") });

	const fresh = run(["find", "note", "uncommitted"], bridge);
	assertOk(fresh, "fresh find failed");
	assert.match(fresh.stdout, new RegExp(UNCOMMITTED));

	const aged = run(["find", "note", "uncommitted", "--min-age", "1m"], bridge);
	assertOk(aged, "aged find failed");
	assert.doesNotMatch(aged.stdout, new RegExp(UNCOMMITTED));
});

test("find reports invalid arguments", () => {
	const bridge = fixture("errors");
	for (const [args, pattern] of [
		[["find", "memo", "x"], /unsupported find role/],
		[["find"], /requires <role>/],
		[["find", "note", "x", "extra"], /unexpected find argument/],
		[["find", "note", "--max-age", "0h"], /invalid find age/],
		[["find", "note", "--age", "1d"], /unknown find option: --age/],
		[["find", "note", "--min-age", "2d", "--max-age", "1d"], /--min-age must be shorter/],
		[["find", "note", "--min-age", "1d", "--max-age", "1d"], /--min-age must be shorter/],
		[["find", "note", "--scope", "no-such-repo"], /unknown find scope/],
		[["find", "note", "--kind"], /--kind requires a kind/],
		[["find", "note", "--kind", "to do"], /--kind must be kebab-case/],
	]) {
		const result = run(args, bridge);
		assert.notEqual(result.status, 0, `expected failure for ${args.join(" ")}`);
		assert.match(result.stderr, pattern);
	}
});
