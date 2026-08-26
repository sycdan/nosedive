import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, run, runGit, write } from "../test-helpers.mjs";

const tmp = createTmp("find");
const BACKLOG = "019fe520-0000-7000-8000-000000000001";
const FEAT = "019fe520-0000-7000-8000-000000000002";
const OLD = "019fe520-0000-7000-8000-000000000003";
const RECENT = "019fe520-0000-7000-8000-000000000004";
const NAMED = "019fe520-0000-7000-8000-000000000005";
const WRONG_REL = "019fe520-0000-7000-8000-000000000006";
const REFERENCE_ONLY = "019fe520-0000-7000-8000-000000000007";

function link(id, rel) {
	return [`  - kb/${id}.md:`, `      rel: ${rel}`];
}

function doc(bridge, kind, id, name, gist, links = []) {
	write(
		join(bridge, "kb", `${id}.md`),
		[
			"---",
			`kind: ${kind}`,
			`id: ${id}`,
			`name: ${name}`,
			`gist: "${gist}"`,
			...(links.length ? ["links:", ...links] : []),
			"---",
			"",
		].join("\n"),
	);
}

function commitAt(bridge, message, date) {
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
		GIT_AUTHOR_DATE: date,
		GIT_COMMITTER_DATE: date,
	};
	const result = spawnSync("git", ["commit", "-m", message], {
		cwd: bridge,
		encoding: "utf8",
		env,
	});
	assert.equal(result.status, 0, result.stderr);
}

function fixture(name) {
	const bridge = createBridge(tmp, name, { backlog: BACKLOG });
	doc(bridge, "memo", BACKLOG, "backlog", "Backlog", link(FEAT, "root.feat"));
	doc(bridge, "feat", FEAT, "nested", "Nested", [
		...link(OLD, "evidence.note"),
		...link(OLD, "duplicate.note"),
		...link(RECENT, "recent.note"),
		...link(NAMED, "named.note"),
		...link(WRONG_REL, "wrong.repo"),
	]);
	doc(bridge, "note", OLD, "old", "Exact Search Term", [...link(REFERENCE_ONLY, "related.note")]);
	doc(bridge, "note", NAMED, "exact-search-term", "Other gist");
	doc(bridge, "note", WRONG_REL, "wrong", "Exact Search Term");
	doc(bridge, "note", REFERENCE_ONLY, "reference-only", "Exact Search Term");
	runGit(["add", "."], bridge);
	commitAt(bridge, "old docs", "2020-01-01T00:00:00Z");
	doc(bridge, "note", RECENT, "recent", "Exact Search Term");
	runGit(["add", "."], bridge);
	commitAt(bridge, "recent doc", new Date().toISOString());
	return bridge;
}

test("find walks nested backlog links, filters rel roles, deduplicates, and matches exact slugs", () => {
	const bridge = fixture("matches");
	const result = run(["find", "note", "Exact search term"], bridge);
	assertOk(result, "find failed");
	assert.equal(result.stdout.match(new RegExp(OLD, "g"))?.length, 1);
	assert.match(result.stdout, new RegExp(RECENT));
	assert.match(result.stdout, new RegExp(NAMED));
	assert.doesNotMatch(result.stdout, new RegExp(WRONG_REL));
	assert.doesNotMatch(result.stdout, new RegExp(REFERENCE_ONLY));
	assert.equal(run(["find", "note", "Exact search"], bridge).stdout, "");
});

test("find lists every matching role when no term is supplied", () => {
	const bridge = fixture("list");
	const result = run(["find", "note"], bridge);
	assertOk(result, "find list failed");
	assert.match(result.stdout, new RegExp(OLD));
	assert.match(result.stdout, new RegExp(RECENT));
	assert.match(result.stdout, new RegExp(NAMED));
	assert.doesNotMatch(result.stdout, new RegExp(WRONG_REL));
	assert.doesNotMatch(result.stdout, new RegExp(REFERENCE_ONLY));
});

test("find --age uses first Git addition", () => {
	const bridge = fixture("age");
	const result = run(["find", "note", "exact-search-term", "--age", "1d"], bridge);
	assertOk(result, "aged find failed");
	assert.match(result.stdout, new RegExp(OLD));
	assert.match(result.stdout, new RegExp(NAMED));
	assert.doesNotMatch(result.stdout, new RegExp(RECENT));
});

test("find reports invalid arguments and unresolved history", () => {
	const bridge = fixture("errors");
	for (const [args, pattern] of [
		[["find", "memo", "x"], /unsupported find role/],
		[["find"], /requires <role>/],
		[["find", "note", "x", "extra"], /unexpected find argument/],
		[["find", "note", "x", "--age", "0h"], /invalid find age/],
	]) {
		const result = run(args, bridge);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, pattern);
	}
	const uncommitted = "019fe520-0000-7000-8000-000000000008";
	doc(bridge, "note", uncommitted, "uncommitted", "Uncommitted Term");
	doc(bridge, "feat", FEAT, "nested", "Nested", link(uncommitted, "uncommitted.note"));
	const missing = run(["find", "note", "uncommitted-term", "--age", "1m"], bridge);
	assert.notEqual(missing.status, 0, `stdout:\n${missing.stdout}\nstderr:\n${missing.stderr}`);
	assert.match(missing.stderr, /could not resolve creation history/);
});
