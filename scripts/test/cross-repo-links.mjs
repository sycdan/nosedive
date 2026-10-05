import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const { helmDoc, helmFeats, helmPicker } = await import(libUrl);
const tmp = createTmp("cross-repo-links");
const B_REPO = "01a0ff4a-e058-7744-b150-cdc7928f345d";
const C_REPO = "01a0ff4a-e059-7323-a55b-3a5064d11e8e";
const B_FEAT = "01a0ff4a-e05a-7284-82e7-83aa36d0c591";
const SHARED = "01a0ff4a-e05b-769b-aa09-bb58c7424f3f";
const FEAT = "01a0ff4a-e05c-7a4c-a99d-309a542f8f82";
const WIDE = "01a0ff4a-e05d-773b-97b5-aec63eb907ea";
const MEMO = "01a0ff4a-e05e-7d11-b793-b2b03df5a0f7";
const MISSING = "01a0ff4a-e05f-71e2-ad84-07f5cab58bb5";
const B_FEAT_LINK = `${B_REPO}:kb/${B_FEAT}.md`;

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

function doc(kind, id, name, gist, scopes = []) {
	const scoped = scopes.length
		? [
				"scopes:",
				...scopes.flatMap(([repo, branch]) => [`  - ${repo}:`, `      work-branch: ${branch}`]),
			]
		: [];
	return [
		"---",
		`kind: ${kind}`,
		`id: ${id}`,
		`name: ${name}`,
		`gist: "${gist}"`,
		...scoped,
		"---",
		"",
		`# ${gist}`,
		"",
	].join("\n");
}

/** Commits kb docs into a repo's source and publishes them to both its remotes. */
function publish(repo, docs) {
	for (const [id, text] of docs) write(join(repo.source, "kb", `${id}.md`), text);
	runTool("git", ["add", "kb"], repo.source);
	gitCommit(repo.source, "kb");
	runTool("git", ["push", "cloud", "main"], repo.source);
	runTool("git", ["push", "local", "main"], repo.source);
}

/**
 * A seeded bridge with two repos, B and C, that both hold a doc with the same
 * id; B also holds a feat scoping itself. The bridge has a feat scoping B, one
 * scoping both, and a memo, the two feats on its backlog.
 */
function world(name) {
	const { bridge } = seededBridge(tmp, name, "pilot@nosedive.invalid");
	const bridgeId = /^bridge: (\S+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];
	const b = implRepo(tmp, `${name}-b`);
	const c = implRepo(tmp, `${name}-c`);
	publish(b, [
		[B_FEAT, doc("feat", B_FEAT, "b-work", "Work in B", [[B_REPO, "work/b"]])],
		[SHARED, doc("memo", SHARED, "shared-in-b", "Shared in B")],
	]);
	publish(c, [[SHARED, doc("memo", SHARED, "shared-in-c", "Shared in C")]]);
	writeImplRepoDoc(bridge, B_REPO, b);
	writeImplRepoDoc(bridge, C_REPO, c);
	const kb = join(bridge, "kb");
	write(
		join(kb, `${FEAT}.md`),
		doc("feat", FEAT, "bridge-work", "Bridge work", [[B_REPO, "work/f"]]),
	);
	write(
		join(kb, `${WIDE}.md`),
		doc("feat", WIDE, "wide-work", "Wide work", [
			[B_REPO, "work/w"],
			[C_REPO, "work/w"],
		]),
	);
	write(join(kb, `${MEMO}.md`), doc("memo", MEMO, "a-memo", "A memo"));
	for (const feat of [FEAT, WIDE])
		assertOk(run(["update-backlog", "--inject", feat], bridge), "backlog injection failed");
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	runTool("git", ["push"], bridge);
	return { bridge, bridgeId, b, c, featPath: join(kb, `${FEAT}.md`) };
}

function linkBFeat(bridge) {
	assertOk(
		run(["crud", FEAT, "--links", "-"], bridge, `${B_FEAT_LINK}: {rel: child.feat}\n`),
		"linking the feat in B failed",
	);
}

test("a bridge feat links a feat in another repo, read from the managed cache and then the checkout", () => {
	const { bridge, b, featPath } = world("link");
	linkBFeat(bridge);
	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`- ${B_FEAT_LINK}:\n {6}rel: child.feat`),
	);
	assert.ok(!existsSync(join(bridge, "workspace", b.name)), "B is not hydrated");

	// Helm's picker offers the feat, and its tree expands into B's feat.
	assert.ok(helmPicker(bridge).choices.some((feat) => feat.id === FEAT));
	assert.ok(helmPicker(bridge, FEAT).feats.some((feat) => feat.id === B_FEAT));
	const cached = helmDoc(bridge, FEAT).links.find((link) => link.id === B_FEAT);
	assert.deepEqual(
		{ type: cached.type, repo: cached.repo, rel: cached.rel, gist: cached.gist },
		{ type: "doc", repo: B_REPO, rel: "child.feat", gist: "Work in B" },
	);
	const opened = helmDoc(bridge, B_FEAT, B_REPO);
	assert.equal(opened.ref, B_FEAT_LINK);
	// Picked, the feat's tree row for B's feat is named the way crud names it.
	const [bFeat] = helmFeats(bridge, FEAT);
	assert.deepEqual(
		{ id: bFeat.id, repo: bFeat.repo, ref: bFeat.ref, hasFeats: bFeat.hasFeats },
		{ id: B_FEAT, repo: B_REPO, ref: B_FEAT_LINK, hasFeats: false },
	);
	assert.match(opened.html, /Work in B/);

	assertOk(run(["hydrate-repo.workspace", B_REPO], bridge), "hydrating B failed");
	const checkoutFeat = join(bridge, "workspace", b.name, "kb", `${B_FEAT}.md`);
	writeFileSync(
		checkoutFeat,
		readFileSync(checkoutFeat, "utf8").replace('gist: "Work in B"', 'gist: "Edited in B"'),
	);
	const hydrated = helmDoc(bridge, FEAT).links.find((link) => link.id === B_FEAT);
	assert.equal(hydrated.gist, "Edited in B", "read from the checkout once hydrated");
});

test("crud refuses a link into a repo the doc does not scope, and one to a missing file", () => {
	const { bridge, featPath } = world("refuse");
	const before = readFileSync(featPath, "utf8");

	const unscoped = run(
		["crud", FEAT, "--links", "-"],
		bridge,
		`${C_REPO}:kb/${SHARED}.md: {rel: related}\n`,
	);
	assert.equal(unscoped.status, 1);
	assert.match(unscoped.stderr, new RegExp(`does not scope repo ${C_REPO}`));

	const missing = run(
		["crud", FEAT, "--links", "-"],
		bridge,
		`${B_REPO}:kb/${MISSING}.md: {rel: related}\n`,
	);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /no doc to link to/);
	assert.match(missing.stderr, new RegExp(`no kb/${MISSING}\\.md in refuse-b`));
	assert.equal(readFileSync(featPath, "utf8"), before, "a refused link writes nothing");
});

test("a bare quid two repos in play both hold is refused as ambiguous", () => {
	const { bridge } = world("ambiguous");
	const recorded = run(["crud", "dive", "--feat", WIDE, "Wide", "work"], bridge, "Work.\n");
	assertOk(recorded, "crud dive failed");
	assertOk(run(["jump", `kb/${recordedDiveId(recorded.stdout)}.md`], bridge), "jump failed");

	const memoPath = join(bridge, "workspace", "__self", "kb", `${MEMO}.md`);
	const before = readFileSync(memoPath, "utf8");
	const refused = run(["crud", MEMO, "--links", "-"], bridge, `${SHARED}: {rel: related}\n`);
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /is in more than one repo in play: ambiguous-b, ambiguous-c/);
	assert.match(refused.stderr, new RegExp(`<repo-quid>:kb/${SHARED}\\.md`));
	assert.equal(readFileSync(memoPath, "utf8"), before);
});

test("a dive on a feat in another repo records it qualified, inherits its scopes, links back and jumps", () => {
	const { bridge, bridgeId, b } = world("dive");
	linkBFeat(bridge);
	assertOk(run(["hydrate-repo.workspace", B_REPO], bridge), "hydrating B failed");
	const checkout = join(bridge, "workspace", b.name);
	const checkoutFeat = join(checkout, "kb", `${B_FEAT}.md`);

	const recorded = run(["crud", "dive", "--feat", B_FEAT_LINK, "Cross", "repo"], bridge, "Work.\n");
	assertOk(recorded, "crud dive on a feat in B failed");
	const id = recordedDiveId(recorded.stdout);
	const dive = readFileSync(join(bridge, "kb", `${id}.md`), "utf8");
	assert.match(dive, new RegExp(`^  feat: ${B_FEAT_LINK}$`, "m"));
	assert.match(dive, new RegExp(`- ${B_REPO}:\n {6}ref: [0-9a-f]{40}\n {6}work-branch: work/b`));
	assert.match(dive, new RegExp(`- ${bridgeId}:`), "the bridge is in scope too");
	const backLink = (rel) => new RegExp(`- ${bridgeId}:kb/${id}\\.md:\n {6}rel: ${rel}`);
	assert.match(readFileSync(checkoutFeat, "utf8"), backLink("planned.dive"));

	const jumped = run(["jump", `kb/${id}.md`], bridge);
	assertOk(jumped, "jump failed");
	assert.match(readFileSync(checkoutFeat, "utf8"), backLink("jumped.dive"));
	assert.equal(git(["log", "-1", "--format=%s"], checkout), `dive(${id}): jumped.dive`);
	assert.equal(git(["status", "--porcelain", "--", "kb"], checkout), "");
});
