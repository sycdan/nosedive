import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createBridge,
	createTmp,
	gitCommit,
	run,
	runTool,
	write,
} from "../test-helpers.mjs";

const tmp = createTmp("work-loop");
const diver = "work-loop@example.test";
const repoId = "019fd591-0000-7000-8000-000000000001";
const gateId = "019fd591-0000-7000-8000-000000000002";
const repoName = "work-loop-repo";
const marker = "feature.txt";

function bareRepo(name) {
	const path = join(tmp, name);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], path);
	return path;
}

/**
 * A gate that asserts something about the implementation repo rather than about
 * the bridge. That is the whole point of the loop: the failure is fixed by
 * committing in a hydrated worktree, so the gate has to be reading one.
 */
const GATE_SCRIPT = `import { existsSync } from "node:fs";
import { join } from "node:path";

export function run(ctx) {
	const repo = ctx.repos[${JSON.stringify(repoName)}];
	if (!repo) {
		console.error("work-loop gate saw no ${repoName} scope");
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

function plannedDiveIds(featPath) {
	const pattern = /kb\/([0-9a-f-]{36})\.md:\n      rel: planned\.dive/g;
	return [...readFileSync(featPath, "utf8").matchAll(pattern)].map((match) => match[1]);
}

/**
 * The full loop a team actually runs: a gate declared on a feat fails during a
 * regression sweep, the failure becomes a dive, a diver claims and jumps it,
 * fixes the implementation repo, watches the same gate go green, lands, and
 * sweeps again.
 *
 * Every step is asserted from the outside -- what a pilot would see -- because
 * the parts have unit coverage already and what has never been proven is that
 * they compose.
 */
test("a failing gate mints work that a diver jumps, fixes, lands, and re-tests clean", () => {
	const cloud = bareRepo("work-loop-cloud.git");
	const local = bareRepo("work-loop-local.git");
	const source = join(tmp, "work-loop-source");
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, "base implementation");
	runTool("git", ["remote", "add", "cloud", cloud], source);
	runTool("git", ["remote", "add", "local", local], source);
	runTool("git", ["push", "cloud", "main"], source);
	runTool("git", ["push", "local", "main"], source);

	const bridge = createBridge(tmp, "bridge");
	runTool("git", ["config", "user.name", "Work Loop Test"], bridge);
	runTool("git", ["config", "user.email", diver], bridge);
	assertOk(run(["seed", "--headless", "--file", "AGENTS.md"], bridge, ""), "seed failed");

	const bridgeOrigin = bareRepo("work-loop-bridge-origin.git");
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "seed bridge");
	runTool("git", ["remote", "add", "origin", bridgeOrigin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: ${repoName}
gist: "Work loop implementation repo"
meta:
  path: workspace/${repoName}
  trunk: main
  remotes:
    cloud: ${cloud.replaceAll("\\", "/")}
    local: ${local.replaceAll("\\", "/")}
---
`,
	);
	write(join(bridge, "kb", "artifacts", "work-loop-gate.mjs"), GATE_SCRIPT);
	write(
		join(bridge, "kb", `${gateId}.md`),
		`---
kind: assertion
id: ${gateId}
name: work-loop-gate
gist: "The implementation repo carries ${marker}"
meta:
  test-script: kb/artifacts/work-loop-gate.mjs
---
`,
	);

	const pitched = run(["pitch", "Ship the work loop feature.", "--name", "work-loop"], bridge);
	assertOk(pitched, "pitch failed");
	const featPath = join(bridge, /^Pitched (.+)$/m.exec(pitched.stdout)?.[1] ?? "");
	const featText = readFileSync(featPath, "utf8");
	const featId = /^id: (\S+)$/m.exec(featText)?.[1];
	assert.ok(featId, `pitched feat has no id:\n${featText}`);
	/**
	 * The gate is declared on the feat, not on the dive: a dive-declared gate has
	 * a dive to attach its failure to already, so only a feat-declared one can
	 * exercise minting.
	 */
	write(
		featPath,
		featText.replace(
			/^---$/m,
			`---\nscopes:\n  - ${repoId}\nlinks:\n  - kb/${gateId}.md:\n      rel: test.gate`,
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
		existsSync(join(bridge, "workspace", repoName)),
		"the sweep must hydrate the gate's declared repo",
	);

	// 2. The failure became claimable work hanging off the feat.
	const minted = plannedDiveIds(featPath);
	assert.equal(minted.length, 1, `exactly one dive should be minted, got ${minted.length}`);
	const mintedId = minted[0];
	const mintedPath = join(bridge, "kb", `${mintedId}.md`);
	const mintedDoc = readFileSync(mintedPath, "utf8");
	assert.match(mintedDoc, /^gist: "triage work-loop-gate failure"$/m);
	assert.match(mintedDoc, new RegExp(`kb/${gateId}\\.md:\\n      rel: test\\.gate`));
	assert.match(mintedDoc, new RegExp(`Gate: ${gateId}`), "the brief must name the failing gate");
	assert.match(mintedDoc, new RegExp(`${marker} is missing`), "the brief must carry the failure");
	assert.match(mintedDoc, new RegExp(`^  feat: ${featId}$`, "m"));

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
	const worktree = join(bridge, "workspace", repoName);

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

	// 8. Land publishes the work branch and closes the dive.
	assertOk(run(["land"], bridge), "land failed");
	const landed = readFileSync(mintedPath, "utf8");
	assert.match(landed, /^kind: memo$/m);
	assert.match(
		readFileSync(featPath, "utf8"),
		new RegExp(`kb/${mintedId}\\.md:\\n      rel: landed\\.dive`),
	);
	const published = runTool(
		"git",
		["show-ref", "--verify", "--hash", "refs/heads/work/work-loop"],
		cloud,
	).stdout.trim();
	assert.match(published, /^[0-9a-f]{40}$/, "land must publish the work branch");

	/**
	 * Landing is not merging. Until the published branch reaches trunk, the pin a
	 * bare-quid scope resolves is still the unfixed commit, so the sweep below
	 * would be reading a worktree that no longer matches what it declared. Doing
	 * the merge here is what makes the final green mean the fix is on trunk
	 * rather than merely on somebody's machine.
	 */
	runTool("git", ["update-ref", "refs/heads/main", published], cloud);

	// 9. The loop closes: the same sweep that minted the work now passes.
	const clean = run(["test"], bridge);
	assertOk(clean, "the backlog sweep must pass once the fix is on trunk");
	assert.match(clean.stdout, /work-loop gate passed/);
	assert.deepEqual(plannedDiveIds(featPath), [], "a passing sweep must mint nothing");
	assert.doesNotMatch(
		clean.stderr,
		/not declared commit/,
		"a merged fix must leave the worktree agreeing with its declared pin",
	);
});
