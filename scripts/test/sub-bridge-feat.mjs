import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	implRepo,
	libUrl,
	recordedDiveId,
	run,
	runTool,
	seededBridge,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const { helmRepoList } = await import(libUrl);
const tmp = createTmp("sub-bridge-feat");
const SUB_REPO = "01a11c8e-6b0c-7ac5-9b12-3c686e6ff187";
const PROPS = "01a11c8e-6b0d-7deb-85d4-b3a4703e4f4e";
const SUB_BACKLOG = "01a11c8e-6b0e-7e6b-94ae-a1639a84eb48";
const WATER = "01a11c8e-6b0f-7a11-84a3-64d2cc417d7f";
const WATER_REF = `${SUB_REPO}:kb/${WATER}.md`;
const BRANCH = "work/props";

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

function doc(kind, id, name, frontmatter = []) {
	return ["---", `kind: ${kind}`, `id: ${id}`, `name: ${name}`, `gist: "${name}"`, ...frontmatter]
		.concat(["---", "", `# ${name}`, ""])
		.join("\n");
}

const links = (...entries) => [
	"links:",
	...entries.flatMap(([target, rel]) => [`  - ${target}:`, `      rel: ${rel}`]),
];

/**
 * The wild-harvest-homestead shape: the bridge's backlog links `properties`,
 * which scopes the sub-bridge on `work/props` and links its backlog as
 * `property.feat`; that backlog links `water` as `system.feat`. By default
 * nothing in the sub-bridge scopes it; `subBranch` has the sub-bridge's
 * backlog scope itself, as a seeded sub-bridge's does.
 */
function world(name, { propsBranch = BRANCH, subBranch } = {}) {
	const { bridge } = seededBridge(tmp, name, "pilot@nosedive.invalid");
	const bridgeId = /^bridge: (\S+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const sub = implRepo(tmp, `${name}-sub`);
	const subScope = subBranch
		? ["scopes:", `  - ${SUB_REPO}:`, `      work-branch: ${subBranch}`]
		: [];
	write(
		join(sub.source, "kb", `${SUB_BACKLOG}.md`),
		doc("memo", SUB_BACKLOG, "bridge", [...subScope, ...links([`kb/${WATER}.md`, "system.feat"])]),
	);
	write(join(sub.source, "kb", `${WATER}.md`), doc("system", WATER, "water"));
	runTool("git", ["add", "kb"], sub.source);
	gitCommit(sub.source, "kb");
	runTool("git", ["push", "cloud", "main"], sub.source);
	runTool("git", ["push", "local", "main"], sub.source);
	writeImplRepoDoc(bridge, SUB_REPO, sub);
	write(
		join(bridge, "kb", `${PROPS}.md`),
		doc("memo", PROPS, "properties", [
			"scopes:",
			...(propsBranch
				? [`  - ${SUB_REPO}:`, `      work-branch: ${propsBranch}`]
				: [`  - ${SUB_REPO}`]),
			...links([`${SUB_REPO}:kb/${SUB_BACKLOG}.md`, "property.feat"]),
		]),
	);
	assertOk(run(["update-backlog", "--inject", PROPS], bridge), "backlog injection failed");
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	runTool("git", ["push"], bridge);
	assertOk(run(["hydrate-repo.workspace", SUB_REPO], bridge), "hydrating the sub-bridge failed");
	const checkout = join(bridge, "workspace", sub.name);
	return { bridge, bridgeId, sub, checkout, water: join(checkout, "kb", `${WATER}.md`) };
}

test("a dive on a feat two links into a sub-bridge scopes it and commits its bookkeeping there", () => {
	const { bridge, bridgeId, sub, checkout, water } = world("walk");
	assert.ok(
		helmRepoList(bridge, WATER_REF).some((repo) => repo.id === SUB_REPO),
		"helm lists the feat's repo in scope",
	);

	const recorded = run(
		["crud", "dive", "--feat", WATER_REF, "Water", "details"],
		bridge,
		"Work.\n",
	);
	assertOk(recorded, "crud dive on the sub-bridge feat failed");
	const id = recordedDiveId(recorded.stdout);
	const dive = readFileSync(join(bridge, "kb", `${id}.md`), "utf8");
	assert.match(
		dive,
		new RegExp(`- ${SUB_REPO}:\n {6}ref: [0-9a-f]{40}\n {6}work-branch: ${BRANCH}`),
	);
	assert.equal(dive.split(`- ${SUB_REPO}:`).length, 2, "the sub-bridge is scoped once");
	assert.match(dive, new RegExp(`- ${bridgeId}:`), "the backlog's scope comes too");
	// Nothing in flight scopes the sub-bridge yet, so planning writes nothing there.
	assert.match(recorded.stderr, /planned\.dive link to dive .* is not written/);
	assert.equal(git(["status", "--porcelain", "--", "kb"], checkout), "");

	const backLink = (rel) => new RegExp(`- ${bridgeId}:kb/${id}\\.md:\n {6}rel: ${rel}`);
	assertOk(run(["jump", `kb/${id}.md`], bridge), "jump failed");
	assert.match(readFileSync(water, "utf8"), backLink("jumped.dive"));
	assert.equal(git(["log", "-1", "--format=%s"], checkout), `dive(${id}): jumped.dive`);
	assert.equal(git(["status", "--porcelain", "--", "kb"], checkout), "");

	const packed = run(["pack"], bridge);
	assertOk(packed, "pack failed");
	assert.doesNotMatch(packed.stderr, /is not written/);
	assert.equal(git(["status", "--porcelain", "--", "kb"], checkout), "");
	assertOk(run(["jump", `kb/${id}.md`], bridge), "re-jump failed");
	assertOk(run(["land"], bridge), "land failed");

	const published = git(["show", `${BRANCH}:kb/${WATER}.md`], sub.cloud);
	assert.match(published, backLink("landed.dive"));
	const subjects = git(["log", "--format=%s", BRANCH], sub.cloud).split("\n");
	for (const rel of ["jumped.dive", "packed.dive", "landed.dive"])
		assert.ok(subjects.includes(`dive(${id}): ${rel}`), `${rel} is published: ${subjects}`);
	assert.equal(git(["status", "--porcelain", "--", "kb"], checkout), "");
});

test("the feat's repo lands on the crossing doc's branch, never the sub-bridge's own", () => {
	const branchOf = (bridge) => {
		const recorded = run(["crud", "dive", "--feat", WATER_REF, "Water"], bridge, "Work.\n");
		assertOk(recorded, "crud dive failed");
		const dive = readFileSync(join(bridge, "kb", `${recordedDiveId(recorded.stdout)}.md`), "utf8");
		return new RegExp(`- ${SUB_REPO}:\n {6}ref: [0-9a-f]{40}\n {6}work-branch: (\\S+)`).exec(
			dive,
		)?.[1];
	};
	assert.equal(branchOf(world("self", { subBranch: "work/kb" }).bridge), BRANCH);
	const bare = world("bare", { propsBranch: null, subBranch: "work/kb" });
	assert.equal(branchOf(bare.bridge), `bare-main/water-${WATER}`);
});

test("a dive that does not scope its feat's repo writes nothing there", () => {
	const { bridge, checkout, water } = world("unscoped");
	const before = readFileSync(water, "utf8");
	const recorded = run(
		["record.dive", "--feat", WATER_REF, "--unscope", SUB_REPO, "--brief", "-"],
		bridge,
		"Work.\n",
	);
	assertOk(recorded, "record.dive failed");
	const id = recordedDiveId(recorded.stdout);
	assert.doesNotMatch(
		readFileSync(join(bridge, "kb", `${id}.md`), "utf8"),
		new RegExp(`- ${SUB_REPO}:`),
	);

	const jumped = run(["jump", `kb/${id}.md`], bridge);
	assertOk(jumped, "jump failed");
	assert.match(jumped.stderr, /jumped\.dive link to dive .* is not written: no dive in flight/);
	const packed = run(["pack"], bridge);
	assertOk(packed, "pack failed");
	assert.match(packed.stderr, /packed\.dive link to dive .* is not written/);
	assert.equal(readFileSync(water, "utf8"), before);
	assert.equal(git(["status", "--porcelain", "--", "kb"], checkout), "");
});
