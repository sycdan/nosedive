import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	implRepo,
	KB_FEAT_ID,
	onLandedKbDive,
	recordedDiveId,
	run,
	runTool,
	seededBridge,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

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

function linkBFeat(bridge, alsoFrom = []) {
	onLandedKbDive(bridge, () => {
		for (const feat of [FEAT, ...alsoFrom])
			assertOk(
				run(["crud", feat, "--links", "-"], bridge, `${B_FEAT_LINK}: {rel: child.feat}\n`),
				`linking the feat in B from ${feat} failed`,
			);
	});
}

test("a bridge feat links a feat in another repo, which reads from the managed cache", () => {
	const { bridge, b, featPath } = world("link");
	linkBFeat(bridge);
	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`- ${B_FEAT_LINK}:\n {6}rel: child.feat`),
	);
	assert.ok(!existsSync(join(bridge, "workspace", b.name)), "B is not hydrated");
	assert.match(run(["crud", B_FEAT_LINK], bridge).stdout, /^gist: "Work in B"$/m);
});

test("crud refuses a link into a repo the doc does not scope, and one to a missing file", () => {
	const { bridge, featPath } = world("refuse");
	const before = readFileSync(featPath, "utf8");
	assertOk(run(["jump", KB_FEAT_ID], bridge), "jump failed");

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
	const recorded = run(
		["record.dive", "--feat", WIDE, "--gist", "Wide work", "--brief", "-"],
		bridge,
		"Work.\n",
	);
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

	const recorded = run(
		["record.dive", "--feat", B_FEAT_LINK, "--gist", "Cross repo", "--brief", "-"],
		bridge,
		"Work.\n",
	);
	assertOk(recorded, "crud dive on a feat in B failed");
	const id = recordedDiveId(recorded.stdout);
	const dive = readFileSync(join(bridge, "kb", `${id}.md`), "utf8");
	assert.match(dive, new RegExp(`^  feat: ${B_FEAT_LINK}$`, "m"));
	assert.match(dive, new RegExp(`- ${B_REPO}:\n {6}ref: [0-9a-f]{40}\n {6}work-branch: work/b`));
	assert.match(dive, new RegExp(`- ${bridgeId}:`), "the bridge is in scope too");
	const backLink = (rel) => new RegExp(`- ${bridgeId}:kb/${id}\\.md:\n {6}rel: ${rel}`);
	// No dive in flight scopes B, so nothing could commit the link: it is not written.
	assert.doesNotMatch(readFileSync(checkoutFeat, "utf8"), backLink("planned.dive"));
	assert.match(recorded.stderr, /planned\.dive link to dive .* is not written: no dive in flight/);
	assert.equal(git(["status", "--porcelain", "--", "kb"], checkout), "");

	const jumped = run(["jump", `kb/${id}.md`], bridge);
	assertOk(jumped, "jump failed");
	assert.match(readFileSync(checkoutFeat, "utf8"), backLink("jumped.dive"));
	assert.equal(git(["log", "-1", "--format=%s"], checkout), `dive(${id}): jumped.dive`);
	assert.equal(git(["status", "--porcelain", "--", "kb"], checkout), "");
});

const GONE_REPO = "01a1198f-f7bc-764d-ad46-3a80781b4770";
const cachePath = (bridge, repo) => join(bridge, ".nosedive", "cache", repo);

test("crud prints a doc from a repo nobody hydrated, out of its managed cache", () => {
	const { bridge, b } = world("read");
	const published = readFileSync(join(b.source, "kb", `${B_FEAT}.md`), "utf8");
	assert.ok(!existsSync(cachePath(bridge, B_REPO)), "B has no cache yet");

	const byPath = run(["crud", B_FEAT_LINK], bridge);
	assertOk(byPath, "crud <repo>:<path> failed");
	assert.equal(byPath.stdout, published, "the doc whole, frontmatter and body");
	assert.ok(existsSync(cachePath(bridge, B_REPO)), "the read cloned the cache");
	assert.ok(!existsSync(join(bridge, "workspace", b.name)), "nothing is hydrated");
	assert.equal(run(["crud", `${B_REPO}:${B_FEAT}`], bridge).stdout, published);

	// A fresh cache is read as it is; a stale one is fetched first.
	publish(b, [[B_FEAT, doc("feat", B_FEAT, "b-work", "Moved on in B")]]);
	assert.match(run(["crud", B_FEAT_LINK], bridge).stdout, /Work in B/);
	const old = new Date(Date.now() - 3_600_000);
	utimesSync(join(cachePath(bridge, B_REPO), "FETCH_HEAD"), old, old);
	assert.match(run(["crud", B_FEAT_LINK], bridge).stdout, /Moved on in B/);
});

test("crud fails a read with one line for a missing doc, no frontmatter or an unreachable remote", () => {
	const { bridge, b } = world("unreadable");
	write(
		join(bridge, "kb", `${GONE_REPO}.md`),
		doc("repo", GONE_REPO, "gone", "Gone").replace(
			"---\n\n",
			`meta:\n  trunk: main\n  remotes:\n    local: ${join(tmp, "nowhere.git").replaceAll("\\", "/")}\n---\n\n`,
		),
	);
	const refuses = (ref, reason) => {
		const failed = run(["crud", ref], bridge);
		assert.equal(failed.status, 1, ref);
		assert.equal(failed.stdout, "", ref);
		assert.match(failed.stderr, reason, ref);
		assert.equal(failed.stderr.trim().split("\n").length, 1, `one line: ${failed.stderr}`);
	};
	refuses(
		`${B_REPO}:kb/${MISSING}.md`,
		new RegExp(`no kb/${MISSING}\\.md in unreadable-b at main`),
	);
	refuses(`${B_REPO}:README.md`, /README\.md in unreadable-b at main has no frontmatter/);
	refuses(`${GONE_REPO}:${MISSING}`, /nowhere\.git/);

	// A stale cache whose remote is gone cannot be fetched.
	rmSync(b.cloud, { recursive: true, force: true });
	const old = new Date(Date.now() - 3_600_000);
	utimesSync(join(cachePath(bridge, B_REPO), "FETCH_HEAD"), old, old);
	refuses(B_FEAT_LINK, /failed to fetch managed cache for repo/);
});
