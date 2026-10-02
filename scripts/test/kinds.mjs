import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createBridge,
	createTmp,
	gitCommit,
	implRepo,
	libUrl,
	root,
	run,
	runTool,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const {
	selectRepo,
	kindSources,
	loadKinds,
	resolveKind,
	parseQualifiedRef,
	validateMeta,
	checkDocMeta,
	bridgeHomed,
	shippedFiles,
} = await import(libUrl);

const KIND = "00000000-0000-70a0-90bd-1d49dc6264b9";
const DIVE_KIND = "00000000-0000-77cb-bcfe-6c9fb07f42ab";

const tmp = createTmp("kinds");
const minted = run(["mint", "6"], tmp);
assertOk(minted, "mint failed");
const [BACKLOG_KIND, CARD_A, CARD_B, REPO_A, REPO_B, DIVE] = minted.stdout.trim().split(/\r?\n/);

const packageSource = { name: "nosedive", root, kbDir: join(root, "kb") };
const packageKinds = loadKinds([packageSource]);
const kindKind = resolveKind(packageKinds, "kind");
const diveKind = resolveKind(packageKinds, "dive");

function kindDoc(id, name, meta) {
	return [
		"---",
		"kind: kind",
		`id: ${id}`,
		`name: ${name}`,
		`gist: "The ${name} kind"`,
		"meta:",
		...meta.map((line) => `  ${line}`),
		"---",
		"",
	].join("\n");
}

const CARD_META = [
	"schema:",
	"  type: object",
	"  additionalProperties: false",
	"  properties:",
	"    condition:",
	"      enum: [mint, played]",
	"    price:",
	"      type: number",
	"      minimum: 0",
];

test("the kind kind validates itself, and the dive kind against it", () => {
	assert.ok(kindKind, "package ships a kind named kind");
	assert.equal(kindKind.id, KIND);
	assert.deepEqual(validateMeta(kindKind, kindKind.meta), []);
	assert.ok(diveKind, "package ships a kind named dive");
	assert.equal(diveKind.id, DIVE_KIND);
	assert.deepEqual(validateMeta(kindKind, diveKind.meta), []);
	assert.equal(resolveKind(packageKinds, "deck"), undefined, "no deck kind ships");
});

test("a kind doc with an open schema, a non-schema, or no schema is rejected", () => {
	const open = validateMeta(kindKind, { schema: { type: "object" } });
	assert.ok(
		open.some((error) => /additionalProperties/.test(error)),
		open.join("\n"),
	);
	const nonSchema = validateMeta(kindKind, {
		schema: { type: 12, additionalProperties: false },
	});
	assert.ok(nonSchema.length > 0, "type: 12 is not a JSON Schema");
	assert.ok(validateMeta(kindKind, {}).some((error) => /schema/.test(error)));
	assert.ok(
		validateMeta(kindKind, {
			schema: { type: "object", additionalProperties: false },
			extra: 1,
		}).length > 0,
		"the kind kind is closed too",
	);
});

test("instances are validated against their kind with path-qualified errors", () => {
	const kinds = loadKindsFrom("instances", [kindDoc(CARD_A, "card", CARD_META)]);
	const card = resolveKind(kinds, "card");
	assert.deepEqual(
		validateMeta(card, {}),
		[],
		"a missing optional field is undefined, not an error",
	);
	assert.deepEqual(validateMeta(card, { condition: "mint", price: 1.5 }), []);
	assert.ok(validateMeta(card, { colour: "red" }).some((error) => /colour/.test(error)));
	assert.ok(validateMeta(card, { price: -1 }).some((error) => /^\/price\b/.test(error)));
	assert.ok(validateMeta(card, { condition: "bad" }).some((error) => /^\/condition\b/.test(error)));

	const unknown = checkDocMeta(kinds, { kind: "widget", meta: { anything: 1 } });
	assert.deepEqual(unknown.errors, []);
	assert.match(unknown.warning, /no kind widget/);
});

test("a dive kind counts only from a bridge; other kinds count anywhere", () => {
	const bridge = createBridge(tmp, "homed");
	write(
		join(bridge, "kb", `${DIVE_KIND}.md`),
		readFileSync(join(root, "kb", `${DIVE_KIND}.md`), "utf8"),
	);
	const bridgeSource = { name: "homed", root: bridge, kbDir: join(bridge, "kb") };
	const homed = bridgeHomed(loadKinds([packageSource, bridgeSource]));
	assert.deepEqual(
		homed.filter((kind) => kind.name === "dive").map((kind) => kind.source.name),
		["homed"],
		"nosedive's own dive kind is not a candidate; the bridge's is",
	);
	assert.equal(resolveKind(homed, "dive").source.root, bridge);
	assert.ok(resolveKind(homed, "memo"), "memo is not bridge-only");
});

test("every unscoped zerostar ships; a scoped or minted one stays in its repo", () => {
	const dir = join(tmp, "ship", "kb");
	write(join(dir, `${KIND}.md`), kindDoc(KIND, "kind", ["schema: {}"]));
	write(join(dir, `${CARD_A}.md`), kindDoc(CARD_A, "internal", ["schema: {}"]));
	write(
		join(dir, "00000000-0000-7000-8000-000000000001.md"),
		'---\nkind: foundation\nid: 00000000-0000-7000-8000-000000000001\nname: x\ngist: "x"\n---\n',
	);
	write(
		join(dir, "00000000-0000-7000-8000-000000000002.md"),
		`---\nkind: noun\nid: 00000000-0000-7000-8000-000000000002\nname: y\ngist: "y"\nscopes:\n  - ${REPO_A}\n---\n`,
	);
	assert.deepEqual(shippedFiles(dir), ["00000000-0000-7000-8000-000000000001.md", `${KIND}.md`]);
});

test("with no dive kinds are the bridge's; on a dive only the scoped repos'", () => {
	const bridge = createBridge(tmp, "context-bridge");
	write(
		join(bridge, "kb", `${BACKLOG_KIND}.md`),
		kindDoc(BACKLOG_KIND, "backlog", [
			"schema:",
			"  type: object",
			"  additionalProperties: false",
		]),
	);
	const repoA = implRepo(tmp, "repo-a");
	const repoB = implRepo(tmp, "repo-b");
	for (const [repo, id] of [
		[repoA, CARD_A],
		[repoB, CARD_B],
	]) {
		// repo-b is installed and keeps its kb where its own nosedive config says.
		const kb = repo === repoB ? "notes" : "kb";
		if (repo === repoB)
			write(join(repo.source, ".nosedive", "config.yaml"), "compatibility-level: 2\nkb: ./notes\n");
		write(join(repo.source, kb, `${id}.md`), kindDoc(id, "card", CARD_META));
		runTool("git", ["add", "."], repo.source);
		gitCommit(repo.source, "card kind");
		runTool("git", ["push", "cloud", "main"], repo.source);
	}
	writeImplRepoDoc(bridge, REPO_A, repoA);
	writeImplRepoDoc(bridge, REPO_B, repoB);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");

	const idleSources = kindSources(bridge);
	const idle = loadKinds(idleSources);
	assert.equal(resolveKind(idle, "backlog")?.id, BACKLOG_KIND);
	assert.equal(resolveKind(idle, "card"), undefined, "no dive: scoped repos are not consulted");

	assertOk(run(["hydrate-repo.workspace", REPO_A], bridge), "hydrate failed");
	assertOk(run(["hydrate-repo.workspace", REPO_B], bridge), "hydrate failed");
	write(
		join(bridge, "kb", `${DIVE}.md`),
		[
			"---",
			"kind: dive",
			`id: ${DIVE}`,
			"name: the-dive",
			'gist: "A dive"',
			"scopes:",
			`  - ${REPO_A}`,
			`  - ${REPO_B}`,
			"---",
			"",
		].join("\n"),
	);
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${DIVE}\n`);

	const diving = loadKinds(kindSources(bridge));
	assert.equal(resolveKind(diving, "backlog"), undefined, "on a dive the bridge is not consulted");
	assert.throws(
		() => resolveKind(diving, "card"),
		(err) =>
			/repo-a/.test(err.message) &&
			/repo-b/.test(err.message) &&
			/name one: repo-a:card, repo-b:card/.test(err.message),
	);
	// <repo>:<kind> takes the kind from one repo, by name or id.
	assert.equal(resolveKind(diving, "repo-a:card")?.id, CARD_A);
	assert.equal(resolveKind(diving, `${REPO_B}:card`)?.id, CARD_B);
	assert.equal(
		resolveKind(diving, "nope:card"),
		undefined,
		"a repo with no such kind has none; crud's selectRepo refuses a repo not in play",
	);
	// selectRepo narrows what is in play to one repo, by name or id.
	const onlyA = loadKinds(selectRepo(kindSources(bridge), "repo-a"));
	assert.equal(resolveKind(onlyA, "card")?.id, CARD_A);
	assert.equal(resolveKind(loadKinds(selectRepo(kindSources(bridge), REPO_B)), "card")?.id, CARD_B);
	assert.throws(() => selectRepo(kindSources(bridge), "nope"), /repo nope is not in context/);
	assert.throws(() => selectRepo(idleSources, "repo-a"), /repo repo-a is not in context/);
});

/** Kinds loaded from a throwaway kb holding the given kind docs. */
function loadKindsFrom(name, docs) {
	const repoRoot = join(tmp, name);
	docs.forEach((text) => {
		const id = /^id: (\S+)$/m.exec(text)[1];
		write(join(repoRoot, "kb", `${id}.md`), text);
	});
	return loadKinds([{ name, root: repoRoot, kbDir: join(repoRoot, "kb") }]);
}

test("parseQualifiedRef splits <repo>:<ref> at the last colon, and leaves an empty side bare", () => {
	assert.deepEqual(parseQualifiedRef("memo"), { ref: "memo" });
	assert.deepEqual(parseQualifiedRef("nosedive:memo"), { repo: "nosedive", ref: "memo" });
	assert.deepEqual(parseQualifiedRef(`${REPO_A}:memo`), { repo: REPO_A, ref: "memo" });
	assert.deepEqual(parseQualifiedRef(`__self:${CARD_A}`), { repo: "__self", ref: CARD_A });
	assert.deepEqual(parseQualifiedRef(":x"), { ref: ":x" });
	assert.deepEqual(parseQualifiedRef("x:"), { ref: "x:" });
});
