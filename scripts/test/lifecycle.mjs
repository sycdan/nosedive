import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	implRepo,
	pitchFeat,
	recordedDiveId,
	run,
	runGit,
	runTool,
	seededBridge,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const tmp = createTmp("lifecycle");
const diver = "lifecycle@example.test";
const repoId = "019fd590-0000-7000-8000-000000000001";
const diveGateId = "019fd590-0000-7000-8000-000000000002";
const featGateId = "019fd590-0000-7000-8000-000000000003";
const workLoopRepoId = "019fd591-0000-7000-8000-000000000001";
const workLoopGateId = "019fd591-0000-7000-8000-000000000002";
const workLoopBranchGateId = "019fd591-0000-7000-8000-000000000003";
const workLoopSecondRepoId = "019fd591-0000-7000-8000-000000000004";
const workLoopThirdRepoId = "019fd591-0000-7000-8000-000000000005";
const marker = "feature.txt";

function assertFeatDiveRel(featPath, diveId, rel) {
	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`kb/${diveId}\\.md:\\n      rel: ${rel}`),
	);
}

function plannedDiveIds(featPath) {
	const pattern = /kb\/([0-9a-f-]{36})\.md:\n      rel: planned\.dive/g;
	return [...readFileSync(featPath, "utf8").matchAll(pattern)].map((match) => match[1]);
}

test("a feat composes through packed, bailed, and landed dives", () => {
	const repo = implRepo(tmp, "lifecycle-repo");
	const { bridge } = seededBridge(tmp, "bridge", diver);
	writeImplRepoDoc(bridge, repoId, repo);

	const { featPath, featId, featText } = pitchFeat(
		bridge,
		"Exercise a complete lifecycle.",
		"lifecycle",
	);
	// The feat says where its repo lands, so the dives under it inherit somewhere
	// to push. The work-loop test below covers the feat that has not said.
	write(
		featPath,
		featText.replace(/^---$/m, `---\nscopes:\n  - ${repoId}:\n      work-branch: work/lifecycle`),
	);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "scope lifecycle feat");
	runTool("git", ["push"], bridge);

	assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate repo failed");
	const first = run(["record.dive", "--feat", featId, "--diver", diver], bridge);
	assertOk(first, "first record.dive failed");
	const firstId = recordedDiveId(first.stdout);
	assertFeatDiveRel(featPath, firstId, "planned\\.dive");
	assertOk(
		run(["record.dive", "--ref", firstId, "--brief", "Test packing and reclaiming."], bridge),
		"first brief failed",
	);
	assertOk(run(["jump"], bridge), "first jump failed");
	assertFeatDiveRel(featPath, firstId, "jumped\\.dive");
	const worktree = join(bridge, "workspace", "lifecycle-repo");
	write(join(worktree, "packed.txt"), "packed work\n");
	runTool("git", ["add", "packed.txt"], worktree);
	gitCommit(worktree, "add packed work");
	assertOk(run(["pack"], bridge), "pack failed");
	assertFeatDiveRel(featPath, firstId, "packed\\.dive");

	const firstPath = join(bridge, "kb", `${firstId}.md`);
	const packed = readFileSync(firstPath, "utf8");
	assert.doesNotMatch(packed, /^  diver: (?!null$).+$/m, "packed dive should be claimable");
	assert.match(packed, /rel: patch/, "packed dive should carry a patch chain");
	assertOk(run(["record.dive", "--ref", firstId, "--diver", diver], bridge), "reclaim failed");
	assertOk(run(["jump"], bridge), "re-jump failed");
	assertFeatDiveRel(featPath, firstId, "jumped\\.dive");
	write(
		join(bridge, "kb", `${diveGateId}.md`),
		`---
kind: assertion
id: ${diveGateId}
name: lifecycle-dive-gate
gist: "Run the lifecycle dive gate"
meta:
  test-script: kb/artifacts/lifecycle-dive-gate.mjs
---
`,
	);
	write(
		join(bridge, "kb", "artifacts", "lifecycle-dive-gate.mjs"),
		'export function run() { console.log("lifecycle dive gate ran"); }\n',
	);
	write(
		join(bridge, "kb", `${featGateId}.md`),
		`---
kind: assertion
id: ${featGateId}
name: lifecycle-feat-gate
gist: "Run the lifecycle feat gate"
meta:
  test-script: kb/artifacts/lifecycle-feat-gate.mjs
---
`,
	);
	write(
		join(bridge, "kb", "artifacts", "lifecycle-feat-gate.mjs"),
		'export function run() { console.log("lifecycle feat gate ran"); }\n',
	);
	write(
		firstPath,
		readFileSync(firstPath, "utf8").replace(
			/^---\n\n/m,
			`links:\n  - kb/${diveGateId}.md:\n      rel: test.gate\n---\n\n`,
		),
	);
	write(
		featPath,
		readFileSync(featPath, "utf8").replace(
			/^links:\n/m,
			`links:\n  - kb/${featGateId}.md:\n      rel: test.gate\n`,
		),
	);
	const diveTests = run(["test"], bridge);
	assertOk(diveTests, "dive-scoped test failed");
	assert.match(diveTests.stdout, /lifecycle dive gate ran/);
	assert.doesNotMatch(diveTests.stdout, /lifecycle feat gate ran/);
	const fullTests = run(["test", "--full"], bridge);
	assertOk(fullTests, "full test failed");
	assert.match(fullTests.stdout, /lifecycle dive gate ran/);
	assert.match(fullTests.stdout, /lifecycle feat gate ran/);
	/**
	 * The feat's gate is broken here rather than the dive's, because the dive
	 * already links its own gate as `test.gate` -- asserting that link would
	 * pass whether or not anything attached it. The feat's gate is one this dive
	 * has never named, so the link can only be there because the failure put it
	 * there.
	 */
	write(
		join(bridge, "kb", "artifacts", "lifecycle-feat-gate.mjs"),
		'export function run() { console.error("lifecycle feat gate failed"); return false; }\n',
	);
	const failedTests = run(["test", "--full"], bridge);
	assert.equal(failedTests.status, 1, "the failing feat gate must fail test --full");
	const testedDive = readFileSync(firstPath, "utf8");
	assert.match(testedDive, /^## Test report \d{4}-\d{2}-\d{2}T.*Z$/m);
	assert.match(testedDive, new RegExp(`kb/${featGateId}\\.md:\\n      rel: test\\.gate`));
	assertOk(run(["jump"], bridge), "reclaim jump failed");
	assertOk(run(["bail", "--reason", "exercise the bail path"], bridge), "bail failed");
	assertFeatDiveRel(featPath, firstId, "bailed\\.dive");
	const bailed = readFileSync(firstPath, "utf8");
	assert.match(bailed, /^kind: memo$/m);
	assert.match(bailed, /^## Bail report\b/m);
	assertOk(run(["update-backlog", "--inject", featId], bridge), "backlog injection failed");
	const featBeforeSweep = plannedDiveIds(featPath);
	const backlogSweep = run(["test"], bridge);
	assert.equal(backlogSweep.status, 1, "the broken feat gate must fail the backlog sweep");
	const mintedId = plannedDiveIds(featPath).find((id) => !featBeforeSweep.includes(id));
	assert.ok(mintedId, "the feat must gain a dive link naming the minted dive");
	const sweptPreflight = run(["preflight"], bridge);
	assertOk(sweptPreflight, "preflight after backlog mint failed");
	assert.match(sweptPreflight.stdout, new RegExp(mintedId));

	const second = run(["record.dive", "--feat", featId, "--diver", diver], bridge);
	assertOk(second, "second record.dive failed");
	const secondId = recordedDiveId(second.stdout);
	assertFeatDiveRel(featPath, secondId, "planned\\.dive");
	const noDiveGates = run(["test"], bridge);
	assert.notEqual(noDiveGates.status, 0, "a dive with no test gates must not pass");
	assert.match(noDiveGates.stderr, /--full/);
	assertOk(
		run(["record.dive", "--ref", secondId, "--brief", "Test landing and publication."], bridge),
		"second brief failed",
	);
	assertOk(run(["jump"], bridge), "second jump failed");
	assertFeatDiveRel(featPath, secondId, "jumped\\.dive");
	write(join(worktree, "landed.txt"), "landed work\n");
	runTool("git", ["add", "landed.txt"], worktree);
	gitCommit(worktree, "add landed work");
	assertOk(run(["land"], bridge), "land failed");

	const landed = readFileSync(join(bridge, "kb", `${secondId}.md`), "utf8");
	assert.match(landed, /^kind: memo$/m);
	assert.match(landed, /^## Outcome$/m);
	assertFeatDiveRel(featPath, secondId, "landed\\.dive");
	const published = runTool(
		"git",
		["show-ref", "--verify", "--hash", "refs/heads/work/lifecycle"],
		repo.cloud,
	).stdout.trim();
	assert.match(published, /^[0-9a-f]{40}$/, "land should publish the work branch to cloud");
});

/**
 * A gate that asserts something about the implementation repo rather than about
 * the bridge. That is the point of the loop below: the failure is fixed by
 * committing in a hydrated worktree, so the gate has to be reading one.
 */
const WORK_LOOP_GATE = `import { existsSync } from "node:fs";
import { join } from "node:path";

export function run(ctx) {
	const repo = ctx.repos["work-loop-repo"];
	if (!repo) {
		console.error("work-loop gate saw no work-loop-repo scope");
		return false;
	}
	if (existsSync(join(ctx.bridgeRoot, repo.root, ${JSON.stringify(marker)}))) {
		console.log("work-loop gate passed");
		return;
	}
	console.error("work-loop gate failed: ${marker} is missing");
	return false;
}
`;

/**
 * A fixture for the branch convention an implementation repo can enforce
 * without making that convention part of nosedive itself.
 */
const WORK_LOOP_BRANCH_GATE = `export async function run(ctx) {
	if (!ctx.diveId) {
		console.log("work-loop branch gate skipped: no landing dive");
		return;
	}
	const repo = ctx.repos["work-loop-repo"];
	if (!repo) {
		console.error("work-loop branch gate saw no work-loop-repo scope");
		return false;
	}
	const dive = await ctx.resolve(ctx.diveId);
	const scope = dive.scopes.find((entry) => entry.repoId === repo.id);
	const expected = "feature/work-loop";
	const found = scope?.workBranch ?? "none";
	if (found === expected) return;
	console.error("work-loop branch gate expected " + expected + ", found " + found);
	return false;
}
`;

/**
 * The loop a team actually runs: a gate declared on a feat fails during a
 * regression sweep, the failure becomes a dive, a diver claims and jumps it,
 * fixes the implementation repo, watches the same gate go green, lands, and
 * sweeps again.
 *
 * Asserted from the outside -- what a pilot would see -- because the parts have
 * unit coverage already and what had never been proven is that they compose.
 */
test("a failing gate mints work that a diver jumps, fixes, lands, and re-tests clean", () => {
	const repo = implRepo(tmp, "work-loop-repo");
	const secondRepo = implRepo(tmp, "work-loop-second-repo");
	const thirdRepo = implRepo(tmp, "work-loop-third-repo");
	const { bridge } = seededBridge(tmp, "work-loop-bridge", diver);
	writeImplRepoDoc(bridge, workLoopRepoId, repo);
	writeImplRepoDoc(bridge, workLoopSecondRepoId, secondRepo);
	writeImplRepoDoc(bridge, workLoopThirdRepoId, thirdRepo);
	write(join(bridge, "kb", "artifacts", "work-loop-gate.mjs"), WORK_LOOP_GATE);
	write(join(bridge, "kb", "artifacts", "work-loop-branch-gate.mjs"), WORK_LOOP_BRANCH_GATE);
	write(
		join(bridge, "kb", `${workLoopGateId}.md`),
		`---
kind: assertion
id: ${workLoopGateId}
name: work-loop-gate
gist: "The implementation repo carries ${marker}"
meta:
  test-script: kb/artifacts/work-loop-gate.mjs
---
`,
	);
	write(
		join(bridge, "kb", `${workLoopBranchGateId}.md`),
		`---
kind: assertion
id: ${workLoopBranchGateId}
name: work-loop-branch-gate
gist: "The implementation repo lands on its feature branch"
meta:
  test-script: kb/artifacts/work-loop-branch-gate.mjs
---
`,
	);
	const repoPath = join(bridge, "kb", `${workLoopRepoId}.md`);
	write(
		repoPath,
		readFileSync(repoPath, "utf8").replace(
			/\n---\n$/,
			`\nlinks:\n  - kb/${workLoopBranchGateId}.md:\n      rel: land.gate\n---\n`,
		),
	);

	const { featPath, featId, featText } = pitchFeat(
		bridge,
		"Ship the work loop feature.",
		"work-loop",
	);
	/**
	 * The gate is declared on the feat, not on the dive: a dive-declared gate has
	 * a dive to attach its failure to already, so only a feat-declared one can
	 * exercise minting.
	 */
	write(
		featPath,
		featText.replace(
			/^---$/m,
			`---\nscopes:\n  - ${workLoopRepoId}\n  - ${workLoopSecondRepoId}:\n      work-branch: work/work-loop\n  - ${workLoopThirdRepoId}:\n      work-branch: work/work-loop\nlinks:\n  - kb/${workLoopGateId}.md:\n      rel: test.gate`,
		),
	);
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "declare the work loop feat and its gate");
	runTool("git", ["push"], bridge);
	assertOk(run(["update-backlog", "--inject", featId], bridge), "backlog injection failed");

	// 1. A regression sweep with no dive on deck. The gate hydrates the repo
	//    read-only, finds no marker file, and fails.
	const sweep = run(["test"], bridge);
	assert.equal(sweep.status, 1, `the sweep must fail:\n${sweep.stdout}\n${sweep.stderr}`);
	assert.match(sweep.stderr + sweep.stdout, new RegExp(`${marker} is missing`));
	assert.ok(
		existsSync(join(bridge, "workspace", repo.name)),
		"the sweep must hydrate the gate's declared repo",
	);

	// 2. The failure became claimable work hanging off the feat.
	const minted = plannedDiveIds(featPath);
	assert.equal(minted.length, 1, `exactly one dive should be minted, got ${minted.length}`);
	const mintedId = minted[0];
	const mintedPath = join(bridge, "kb", `${mintedId}.md`);
	const mintedDoc = readFileSync(mintedPath, "utf8");
	assert.match(mintedDoc, /^gist: "triage work-loop-gate failure"$/m);
	assert.match(mintedDoc, new RegExp(`kb/${workLoopGateId}\\.md:\\n      rel: test\\.gate`));
	assert.match(
		mintedDoc,
		new RegExp(`Gate: ${workLoopGateId}`),
		"the brief must name the failing gate",
	);
	assert.match(mintedDoc, new RegExp(`${marker} is missing`), "the brief must carry the failure");
	assert.match(mintedDoc, new RegExp(`^  feat: ${featId}$`, "m"));
	/**
	 * The feat never said where this repo lands, so the minted dive names no
	 * branch either -- and no `mode` key, which decides nothing and is no longer
	 * written at all. Step 8 is where that costs something.
	 */
	assert.match(
		mintedDoc,
		new RegExp(`^  - ${workLoopRepoId}:\\n      ref: [0-9a-f]{40}$`, "m"),
		"the gated repo must name no work branch",
	);
	assert.doesNotMatch(mintedDoc, /^      mode: /m);

	// 3. Preflight offers it, so a pilot finds the work without being told it exists.
	const offered = run(["preflight"], bridge);
	assertOk(offered, "preflight after minting failed");
	assert.match(offered.stdout, new RegExp(mintedId));
	assert.match(offered.stdout, /triage work-loop-gate failure/);

	// 4. Sweeping again must not mint a second dive for the same gate.
	const resweep = run(["test"], bridge);
	assert.equal(resweep.status, 1, "the gate is still broken, so the sweep still fails");
	assert.deepEqual(plannedDiveIds(featPath), [mintedId], "a second sweep must not mint again");

	// 5. Claim and jump it.
	assertOk(run(["record.dive", "--ref", mintedId, "--diver", diver], bridge), "claim failed");
	assertOk(run(["jump"], bridge), "jump failed");
	const worktree = join(bridge, "workspace", repo.name);

	// 6. The dive selects the gate it was minted for, with no --full needed.
	const onDive = run(["test"], bridge);
	assert.equal(onDive.status, 1, "the dive's own gate must still fail before the fix");
	assert.match(onDive.stderr + onDive.stdout, new RegExp(`${marker} is missing`));
	assert.match(readFileSync(mintedPath, "utf8"), /^## Test report \d{4}-\d{2}-\d{2}T.*Z$/m);

	// 7. Fix it where the gate is looking.
	write(join(worktree, marker), "the feature\n");
	runTool("git", ["add", marker], worktree);
	gitCommit(worktree, "add the work loop feature");

	const fixed = run(["test"], bridge);
	assertOk(fixed, "the gate must pass once the repo carries the marker");
	assert.match(fixed.stdout, /work-loop gate passed/);

	/**
	 * 8. The feat never said where this repo lands, so neither does the dive it
	 * minted. The commits exist and have nowhere to go, and land says so rather
	 * than inventing a branch.
	 */
	const homeless = run(["land"], bridge);
	assert.notEqual(homeless.status, 0, "work with nowhere to go must not land");
	assert.match(homeless.stderr, /names no work branch/);
	assert.match(homeless.stderr, new RegExp(`--upscope ${workLoopRepoId}`));

	// 9. Upscoping without a branch takes nosedive's generated default.
	assertOk(
		run(["record.dive", "--ref", mintedId, "--upscope", workLoopRepoId], bridge),
		"--upscope failed",
	);
	assert.match(readFileSync(mintedPath, "utf8"), /^      work-branch: work\/work-loop$/m);

	/**
	 * 10. A branch now exists, so land reaches the convention declared by the
	 * implementation repo. The default is wrong for this fixture, and every push
	 * waits until gates pass.
	 */
	const defaultBranch = run(["land"], bridge);
	assert.notEqual(defaultBranch.status, 0, "the repo's branch convention must refuse land");
	assert.match(
		defaultBranch.stderr + defaultBranch.stdout,
		/work-loop branch gate expected feature\/work-loop, found work\/work-loop/,
	);
	const unpublishedDefault = runGit(
		["show-ref", "--verify", "--quiet", "refs/heads/work/work-loop"],
		repo.cloud,
		{ expectOk: false },
	);
	assert.notEqual(unpublishedDefault.status, 0, "a failed gate must publish no default branch");

	/**
	 * 11. One composed edit puts the gated repo and a second real repo on the
	 * branch the pilot chose, while dropping a third repo from this landing.
	 */
	assertOk(
		run(
			[
				"record.dive",
				"--ref",
				mintedId,
				"--upscope",
				workLoopRepoId,
				"--upscope",
				workLoopSecondRepoId,
				"--unscope",
				workLoopThirdRepoId,
				"--work-branch",
				"feature/work-loop",
			],
			bridge,
		),
		"composed scope edit failed",
	);
	const chosenScope = readFileSync(mintedPath, "utf8");
	for (const id of [workLoopRepoId, workLoopSecondRepoId]) {
		assert.match(
			chosenScope,
			new RegExp(
				`^  - ${id}:\\n      ref: [0-9a-f]{40}\\n      work-branch: feature/work-loop$`,
				"m",
			),
		);
	}
	assert.doesNotMatch(chosenScope, new RegExp(`^  - ${workLoopThirdRepoId}:`, "m"));

	// 12. The accepted branch lands both upscoped implementation repos together.
	assertOk(run(["land"], bridge), "land failed");
	assert.match(readFileSync(mintedPath, "utf8"), /^kind: memo$/m);
	assertFeatDiveRel(featPath, mintedId, "landed\\.dive");
	const published = runTool(
		"git",
		["show-ref", "--verify", "--hash", "refs/heads/feature/work-loop"],
		repo.cloud,
	).stdout.trim();
	assert.match(published, /^[0-9a-f]{40}$/, "land must publish the work branch");
	const secondPublished = runTool(
		"git",
		["show-ref", "--verify", "--hash", "refs/heads/feature/work-loop"],
		secondRepo.cloud,
	).stdout.trim();
	assert.match(secondPublished, /^[0-9a-f]{40}$/, "land must publish the second repo");

	/**
	 * Landing is not merging. Until the published branch reaches trunk, the pin a
	 * bare-quid scope resolves is still the unfixed commit, so the sweep below
	 * would be reading a worktree that no longer matches what it declared. Doing
	 * the merge here is what makes the final green mean the fix is on trunk
	 * rather than merely on somebody's machine.
	 */
	runTool("git", ["update-ref", "refs/heads/main", published], repo.cloud);

	// 13. The loop closes: the same sweep that minted the work now passes.
	const clean = run(["test"], bridge);
	assertOk(clean, "the backlog sweep must pass once the fix is on trunk");
	assert.match(clean.stdout, /work-loop gate passed/);
	assert.match(clean.stdout, /work-loop branch gate skipped: no landing dive/);
	assert.deepEqual(plannedDiveIds(featPath), [], "a passing sweep must mint nothing");
	assert.doesNotMatch(
		clean.stderr,
		/not declared commit/,
		"a merged fix must leave the worktree agreeing with its declared pin",
	);
});
