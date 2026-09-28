import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
	seededBridge,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const {
	kindSources,
	loadKinds,
	resolveKind,
	validateMeta,
	checkDocMeta,
	crudScriptPath,
	shippedKindFiles,
} = await import(libUrl);

const KIND = "00000000-0000-70a0-90bd-1d49dc6264b9";
const DECK = "00000000-0000-7d1f-805a-7d0a3bdff309";

const tmp = createTmp("kinds");
const minted = run(["mint", "6"], tmp);
assertOk(minted, "mint failed");
const [BACKLOG_KIND, CARD_A, CARD_B, REPO_A, REPO_B, DIVE] = minted.stdout.trim().split(/\r?\n/);

const packageSource = { name: "nosedive", root, kbDir: join(root, "kb") };
const packageKinds = loadKinds([packageSource]);
const kindKind = resolveKind(packageKinds, "kind");
const deckKind = resolveKind(packageKinds, "deck");

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

test("the kind kind validates itself, and the deck kind against it", () => {
	assert.ok(kindKind, "package ships a kind named kind");
	assert.equal(kindKind.id, KIND);
	assert.deepEqual(validateMeta(kindKind, kindKind.meta), []);
	assert.ok(deckKind, "package ships a kind named deck");
	assert.equal(deckKind.id, DECK);
	assert.deepEqual(validateMeta(kindKind, deckKind.meta), []);
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

test("crud-script resolves nosedive: in the package and anything else in the kind's repo", () => {
	assert.equal(
		crudScriptPath(deckKind),
		join(root, "kb", "artifacts", `${DECK}.mjs`),
		"the deck kind names its script in the package",
	);
	const kinds = loadKindsFrom("scripts", [
		kindDoc(CARD_A, "card", [...CARD_META, "crud-script: scripts/card.mjs"]),
	]);
	const card = resolveKind(kinds, "card");
	assert.equal(crudScriptPath(card), join(tmp, "scripts", "scripts", "card.mjs"));
});

test("only zerostar kind docs ship", () => {
	const dir = join(tmp, "ship", "kb");
	write(join(dir, `${KIND}.md`), kindDoc(KIND, "kind", ["schema: {}"]));
	write(join(dir, `${CARD_A}.md`), kindDoc(CARD_A, "internal", ["schema: {}"]));
	write(
		join(dir, "00000000-0000-7000-8000-000000000001.md"),
		'---\nkind: foundation\nid: 00000000-0000-7000-8000-000000000001\nname: x\ngist: "x"\n---\n',
	);
	assert.deepEqual(shippedKindFiles(dir), [`${KIND}.md`]);
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
		write(join(repo.source, "kb", `${id}.md`), kindDoc(id, "card", CARD_META));
		runTool("git", ["add", "."], repo.source);
		gitCommit(repo.source, "card kind");
		runTool("git", ["push", "cloud", "main"], repo.source);
	}
	writeImplRepoDoc(bridge, REPO_A, repoA);
	writeImplRepoDoc(bridge, REPO_B, repoB);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");

	const idle = loadKinds(kindSources(bridge));
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
		(err) => /card\.repo-a/.test(err.message) && /card\.repo-b/.test(err.message),
	);
	assert.equal(resolveKind(diving, "card.repo-a")?.id, CARD_A);
	assert.equal(resolveKind(diving, "card.repo-b")?.id, CARD_B);
});

test("seed copies the shipped kind docs into the bridge and overwrites an edited copy", () => {
	const { bridge } = seededBridge(tmp, "seeded", "pilot@nosedive.invalid");
	const shipped = shippedKindFiles(join(root, "kb"));
	assert.deepEqual([...shipped].sort(), [`${KIND}.md`, `${DECK}.md`].sort());
	for (const file of shipped) {
		assert.equal(
			readFileSync(join(bridge, "kb", file), "utf8"),
			readFileSync(join(root, "kb", file), "utf8"),
		);
	}
	assert.equal(
		existsSync(join(bridge, "kb", "artifacts", `${DECK}.mjs`)),
		false,
		"a nosedive: script stays in the package",
	);
	assert.equal(runTool("git", ["status", "--porcelain", "kb"], bridge).stdout.trim(), "");

	const deckCopy = join(bridge, "kb", `${DECK}.md`);
	write(deckCopy, readFileSync(deckCopy, "utf8").replace("nosedive:", "scripts/"));
	const again = run(["seed", "--headless"], bridge, "");
	assertOk(again, "seed failed");
	assert.match(again.stdout, new RegExp(`Replaced kb[\\\\/]${DECK}\\.md`));
	assert.equal(
		readFileSync(deckCopy, "utf8"),
		readFileSync(join(root, "kb", `${DECK}.md`), "utf8"),
	);
	assert.equal(runTool("git", ["status", "--porcelain", "kb"], bridge).stdout.trim(), "");
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
