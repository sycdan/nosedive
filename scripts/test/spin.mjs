import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { createBridge, createTmp, run, write } from "../test-helpers.mjs";

const tmp = createTmp("spin");
const ids = {
	dive: "019fdb00-0000-7000-8000-000000000001",
	child: "019fdb00-0000-7000-8000-000000000002",
	parent: "019fdb00-0000-7000-8000-000000000003",
	childRepo: "019fdb00-0000-7000-8000-000000000004",
	parentRepo: "019fdb00-0000-7000-8000-000000000005",
	api: "019fdb00-0000-7000-8000-000000000006",
	database: "019fdb00-0000-7000-8000-000000000007",
	shared: "019fdb00-0000-7000-8000-000000000008",
};

function writeDoc(bridge, filename, frontmatter) {
	write(join(bridge, "kb", filename), `---\n${frontmatter}\n---\n`);
}

function activeDive(bridge, effort) {
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${ids.dive}\n`);
	writeDoc(
		bridge,
		"dive.md",
		`kind: dive\nid: ${ids.dive}\nname: dive\ngist: "Dive"\nmeta:\n  effort: ${effort}`,
	);
}

test("spin refuses without an active dive", () => {
	const bridge = createBridge(tmp, "no-dive");
	writeDoc(bridge, "empty.md", 'kind: memo\nid: empty\nname: empty\ngist: "Empty"');
	const result = run(["spin", "api"], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /no active dive/);
	assert.equal(result.stdout, "");

	const wordless = run(["spin"], bridge);
	assert.notEqual(wordless.status, 0);
	assert.match(wordless.stderr, /no active dive/);
});

test("spin requires pilot words", () => {
	const bridge = createBridge(tmp, "no-words");
	activeDive(bridge, ids.child);
	writeDoc(bridge, "effort.md", `kind: feat\nid: ${ids.child}\nname: effort\ngist: "Effort"`);
	const result = run(["spin"], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /requires words/);
});

test("spin lists unique loads from the active feat and its ancestors", () => {
	const bridge = createBridge(tmp, "candidates");
	activeDive(bridge, ids.child);
	writeDoc(
		bridge,
		"child.md",
		`kind: feat\nid: ${ids.child}\nname: child\ngist: "Child"\nscopes:\n  - ${ids.childRepo}: {}\nlinks:\n  - kb/${ids.parent}.md:\n      rel: parent`,
	);
	writeDoc(
		bridge,
		"parent.md",
		`kind: feat\nid: ${ids.parent}\nname: parent\ngist: "Parent"\nscopes:\n  - ${ids.parentRepo}: {}`,
	);
	writeDoc(
		bridge,
		"repo-child.md",
		`kind: repo\nid: ${ids.childRepo}\nname: child-repo\ngist: "Child repo"\nlinks:\n  - kb/${ids.api}.md:\n      rel: load\n  - kb/${ids.shared}.md:\n      rel: load`,
	);
	writeDoc(
		bridge,
		"repo-parent.md",
		`kind: repo\nid: ${ids.parentRepo}\nname: parent-repo\ngist: "Parent repo"\nlinks:\n  - kb/${ids.database}.md:\n      rel: load\n  - kb/${ids.shared}.md:\n      rel: load`,
	);
	writeDoc(bridge, "load-a.md", `kind: load\nid: ${ids.api}\nname: api\ngist: "API service"`);
	writeDoc(
		bridge,
		"load-b.md",
		`kind: load\nid: ${ids.database}\nname: database\ngist: "Database service"`,
	);
	writeDoc(
		bridge,
		"load-shared.md",
		`kind: load\nid: ${ids.shared}\nname: shared\ngist: "Shared service"`,
	);

	const result = run(["spin", "api", "and", "database"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Pilot words: api and database/);
	assert.match(result.stdout, /- api: API service/);
	assert.match(result.stdout, /- database: Database service/);
	assert.match(result.stdout, /- shared: Shared service/);
	assert.equal((result.stdout.match(/- shared: Shared service/g) ?? []).length, 1);
});

test("spin identifies scoped repos without documented loads", () => {
	const bridge = createBridge(tmp, "loadless");
	activeDive(bridge, ids.child);
	writeDoc(
		bridge,
		"effort.md",
		`kind: feat\nid: ${ids.child}\nname: effort\ngist: "Effort"\nscopes:\n  - ${ids.childRepo}: {}`,
	);
	writeDoc(
		bridge,
		"repo.md",
		`kind: repo\nid: ${ids.childRepo}\nname: toolbox\ngist: "A library with nothing runnable"`,
	);
	const result = run(["spin", "web"], bridge);
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stdout,
		new RegExp(`toolbox documents no loads; if it runs services, scan --repo ${ids.childRepo}`),
	);
	assert.doesNotMatch(result.stdout, /has not been scanned/);
});
