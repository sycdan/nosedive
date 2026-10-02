import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	implRepo,
	run,
	runTool,
	seededBridge,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const tmp = createTmp("bridge-scope");
const IMPL = "01a0fe62-950b-73c8-a998-4d0402f3e9ae";
const FEAT = "01a0fe62-950c-7d56-b26a-4d18730f1793";

/** A seeded bridge registering one other repo, and a feat scoping `featScopes`. */
function setup(name, featScopes) {
	const { bridge } = seededBridge(tmp, name, "pilot@nosedive.invalid");
	const configPath = join(bridge, ".nosedive", "config.yaml");
	const bridgeId = /^bridge: (\S+)$/m.exec(readFileSync(configPath, "utf8"))[1];
	writeImplRepoDoc(bridge, IMPL, implRepo(tmp, `${name}-impl`));
	const scopes = featScopes({ bridgeId })
		.map(([id, branch]) => `  - ${id}:\n      work-branch: ${branch}\n`)
		.join("");
	write(
		join(bridge, "kb", `${FEAT}.md`),
		`---\nkind: feat\nid: ${FEAT}\nname: impl-work\ngist: "Impl work"\nscopes:\n${scopes}---\n\n# Impl work\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	return { bridge, bridgeId };
}

const implOnly = () => [[IMPL, "work/impl"]];

function recordDive(bridge, args) {
	const recorded = run(["record.dive", "--feat", FEAT, ...args], bridge);
	assertOk(recorded, "record.dive failed");
	const path = /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1];
	return { text: readFileSync(join(bridge, path), "utf8"), stderr: recorded.stderr };
}

/** The dive's scopes as `repo -> work-branch`, in order. */
function scopesOf(text) {
	const block = /^scopes:\n((?: .*\n)*)/m.exec(text)?.[1] ?? "";
	return [
		...block.matchAll(/^ {2}- (\S+):\n(?: {6}ref: \S+\n)?(?: {6}work-branch: (\S+)\n)?/gm),
	].map(([, repo, branch]) => [repo, branch]);
}

test("a feat already scoping the bridge hands down its own branch, once", () => {
	const both = ({ bridgeId }) => [
		[IMPL, "work/impl"],
		[bridgeId, "work/mine"],
	];
	const { bridge, bridgeId } = setup("already", both);
	assert.deepEqual(scopesOf(recordDive(bridge, []).text), [
		[IMPL, "work/impl"],
		[bridgeId, "work/mine"],
	]);
	// With the inherited scopes cleared, the feat's branch for the bridge still answers.
	assert.deepEqual(scopesOf(recordDive(bridge, ["--clear-scopes"]).text), [
		[bridgeId, "work/mine"],
	]);
});

test("--clear-scopes keeps the bridge scope, and only an explicit --unscope drops it", () => {
	const { bridge, bridgeId } = setup("clear", implOnly);
	assert.deepEqual(scopesOf(recordDive(bridge, ["--clear-scopes"]).text), [[bridgeId, "work/kb"]]);
	assert.deepEqual(scopesOf(recordDive(bridge, ["--unscope", bridgeId]).text), [
		[IMPL, "work/impl"],
	]);
});

test("a feat scoping nothing is still warned about, though the dive scopes the bridge", () => {
	const { bridge, bridgeId } = setup("unscoped", () => []);
	const recorded = recordDive(bridge, []);
	assert.match(recorded.stderr, /scope no repos/);
	assert.deepEqual(scopesOf(recorded.text), [[bridgeId, "work/kb"]]);
});
