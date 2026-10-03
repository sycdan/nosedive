import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	implRepo,
	libUrl,
	pitchFeat,
	run,
	runTool,
	seededBridge,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const { helmCreatableKinds, helmPicker } = await import(libUrl);
const tmp = createTmp("self-dive");
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

test("a memo made on a dive that scopes the bridge goes to its __self checkout, and the live bridge is untouched", () => {
	const { bridge, origin } = seededBridge(tmp, "self", "pilot@nosedive.invalid");
	const configPath = join(bridge, ".nosedive", "config.yaml");
	const liveConfig = readFileSync(configPath, "utf8");

	// The kb feat scopes the bridge itself, so jumping a dive on it hydrates __self.
	const recorded = run(
		["crud", "dive", "--feat", KB_FEAT, "Add", "a", "memo"],
		bridge,
		"Make a memo.\n",
	);
	assertOk(recorded, "crud dive failed");
	const divePath = /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1];
	assertOk(run(["jump", divePath], bridge), "jump failed");
	const self = join(bridge, "workspace", "__self");

	// The dive bar offers what the dive can make: the bridge's kinds, but no dive kind.
	assert.deepEqual(
		helmCreatableKinds(bridge).map((kind) => `${kind.repoName}:${kind.name}`),
		["self:kind", "self:memo"],
	);
	assert.ok(helmCreatableKinds(bridge)[1].schema, "each kind carries its schema for the form");

	const made = run(["crud", "memo", "--name", "Magic Cards", "Cards", "I", "own"], bridge);
	assertOk(made, "crud memo failed");
	const memoId = /Minted \S*?([0-9a-f-]{36})\.md/.exec(made.stdout)?.[1];
	assert.equal(
		git(["log", "-1", "--format=%s"], self),
		`crud(${memoId}): created memo magic-cards`,
	);
	// A config change made in the checkout, as a pilot would.
	const selfConfig = join(self, ".nosedive", "config.yaml");
	writeFileSync(selfConfig, `${readFileSync(selfConfig, "utf8")}picker-level: 1\n`);
	runTool("git", ["add", ".nosedive/config.yaml"], self);
	runTool("git", ["commit", "-m", "a picker"], self);

	// Helm shows the bridge as the dive has it, the kb feat first; the live config sets its level.
	const view = helmPicker(bridge);
	assert.equal(view.level, 0);
	assert.deepEqual(view.choices, []);
	assert.equal(view.feats[0].id, KB_FEAT);
	const backlog = /^backlog: (\S+)$/m.exec(liveConfig)[1];
	assert.equal(view.backlog.id, backlog);
	assert.equal(view.locked, true, "on a dive the pick is locked");
	assert.equal(view.pick, undefined, "at level 0 a dive shows the whole backlog");
	assert.equal(helmPicker(bridge, KB_FEAT).pick, undefined, "a pick cannot move a locked one");

	// A dive planned on the dive -- on the very feat being dived, which jump has
	// just edited in the live bridge -- is written and committed in __self too,
	// claims nothing, and lands without a conflict.
	const featId = KB_FEAT;
	const planned = run(
		["crud", "dive", "--feat", featId, "--title", "Next", "Plan", "the", "next", "one"],
		bridge,
		"Do the next thing.\n",
	);
	assertOk(planned, "crud dive on a dive failed");
	const plannedPath = /^Recorded (\S+)$/m.exec(planned.stdout)?.[1];
	assert.match(plannedPath, /^workspace[\\/]__self[\\/]kb[\\/]/);
	assert.match(planned.stdout, /nosedive land/);
	const plannedId = /([0-9a-f-]{36})\.md$/.exec(plannedPath)[1];
	assert.match(git(["log", "-1", "--format=%s"], self), /^dive\(\S+\): created$/);
	assert.match(
		readFileSync(join(self, "kb", `${featId}.md`), "utf8"),
		new RegExp(`${plannedId}\\.md:\\n\\s+rel: planned\\.dive`),
		"linked from the feat in __self",
	);
	assert.equal(git(["status", "--porcelain"], self), "");
	assert.match(
		readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"),
		new RegExp(/[0-9a-f-]{36}/.exec(divePath)[0]),
		"the dive on deck is still the one jumped",
	);

	assert.match(
		readFileSync(join(self, ".nosedive", "config.yaml"), "utf8"),
		/^picker-level: 1$/m,
		"set in the checkout's own config",
	);
	assert.equal(
		readFileSync(configPath, "utf8"),
		liveConfig,
		"the live bridge's config is untouched",
	);
	assert.equal(git(["status", "--porcelain", "--", ".nosedive", "kb"], bridge), "");

	// Land pushes the checkout to its work branch and brings it into the live bridge, which publishes it.
	const landed = run(["land"], bridge);
	assertOk(landed, "land failed");
	assert.match(landed.stderr, /brought the bridge's own scope into the bridge/);
	assert.match(git(["show", "work/kb:.nosedive/config.yaml"], origin), /^picker-level: 1$/m);
	assert.match(git(["show", "main:.nosedive/config.yaml"], origin), /^picker-level: 1$/m);
	assert.match(readFileSync(configPath, "utf8"), /^picker-level: 1$/m);
	assert.match(readFileSync(join(bridge, "kb", `${memoId}.md`), "utf8"), /^name: magic-cards$/m);
	assert.match(readFileSync(join(bridge, "kb", `${plannedId}.md`), "utf8"), /^# Next$/m);
	assert.equal(git(["status", "--porcelain", "--", ".nosedive", "kb"], bridge), "");

	assert.deepEqual(helmCreatableKinds(bridge), [], "with no dive helm makes nothing");

	// With no dive the pilot picks among what the backlog's feat links reach.
	const picked = helmPicker(bridge, KB_FEAT);
	assert.equal(picked.locked, false);
	assert.ok(picked.choices.some((choice) => choice.id === KB_FEAT));
	assert.equal(picked.pick, KB_FEAT);
	assert.equal(helmPicker(bridge, "not-a-pick").pick, undefined, "an unknown pick is no pick");
});

test("the bridge's own scope lands alongside commits the live bridge holds, and a conflict writes nothing", () => {
	const { bridge, origin } = seededBridge(tmp, "self-ahead", "pilot@nosedive.invalid");
	const recorded = run(
		["crud", "dive", "--feat", KB_FEAT, "Add", "a", "memo"],
		bridge,
		"Make a memo.\n",
	);
	assertOk(recorded, "crud dive failed");
	assertOk(run(["jump", /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1]], bridge), "jump failed");
	const self = join(bridge, "workspace", "__self");
	assertOk(run(["crud", "memo", "--name", "ideas", "Ideas"], bridge), "crud memo failed");

	// A local-only bridge commit adding the same file the dive adds conflicts.
	writeFileSync(join(bridge, "shared.md"), "the live bridge says one thing\n");
	runTool("git", ["add", "shared.md"], bridge);
	runTool("git", ["commit", "-m", "live edit"], bridge);
	writeFileSync(join(self, "shared.md"), "the dive says another\n");
	runTool("git", ["add", "shared.md"], self);
	runTool("git", ["commit", "-m", "dive edit"], self);
	const head = git(["rev-parse", "HEAD"], bridge);
	const workBranch = () => git(["branch", "--list", "--format=%(objectname)", "work/kb"], origin);
	const pushedBefore = workBranch();
	const refused = run(["land"], bridge);
	assert.equal(refused.status, 1, refused.stdout);
	assert.match(refused.stderr, /does not apply to the bridge/);
	assert.match(refused.stderr, /nothing was pushed/);
	assert.equal(workBranch(), pushedBefore, "a refused land strands nothing on the work branch");
	assert.match(refused.stderr, /shared\.md/);
	assert.equal(git(["rev-parse", "HEAD"], bridge), head, "the live bridge is as it was");
	assert.equal(git(["status", "--porcelain", "--", "shared.md"], bridge), "");

	// Without the conflict, the live bridge's own commit and the dive's publish together.
	runTool("git", ["reset", "--hard", "HEAD~1"], bridge);
	writeFileSync(join(bridge, "local.md"), "only here\n");
	runTool("git", ["add", "local.md"], bridge);
	runTool("git", ["commit", "-m", "local only"], bridge);
	const landed = run(["land"], bridge);
	assertOk(landed, "land failed");
	const published = git(["log", "--format=%s", "main"], origin);
	assert.match(published, /local only/);
	assert.match(published, /created memo ideas/);
	assert.match(published, /dive edit/);
});

const IMPL_REPO = "01a0fe76-1da6-7642-a463-38849050d728";

/** A seeded bridge holding one other repo, and a feat scoping only that repo. */
function bridgeWithImplFeat(name) {
	const seeded = seededBridge(tmp, name, "pilot@nosedive.invalid");
	writeImplRepoDoc(seeded.bridge, IMPL_REPO, implRepo(tmp, `${name}-impl`));
	runTool("git", ["add", "--", "kb"], seeded.bridge);
	runTool("git", ["commit", "-m", "add an impl repo"], seeded.bridge);
	runTool("git", ["push"], seeded.bridge);
	const { featId } = pitchFeat(seeded.bridge, "Impl work.", `${name}-feat`, IMPL_REPO);
	const config = readFileSync(join(seeded.bridge, ".nosedive", "config.yaml"), "utf8");
	return { ...seeded, featId, bridgeId: /^bridge: (\S+)$/m.exec(config)[1] };
}

const scopeIds = (text) => [...text.matchAll(/^  - (\S+):$/gm)].map((match) => match[1]);

test("every new dive scopes the bridge, and kb writes on it go to __self", () => {
	const { bridge, featId, bridgeId } = bridgeWithImplFeat("every-dive");
	const recorded = run(["crud", "dive", "--feat", featId, "Impl"], bridge, "Do impl work.\n");
	assertOk(recorded, "crud dive failed");
	const divePath = /^Recorded (\S+)$/m.exec(recorded.stdout)?.[1];
	const text = readFileSync(join(bridge, divePath), "utf8");
	const scopes = text.slice(text.indexOf("scopes:"), text.indexOf("meta:"));
	assert.deepEqual(scopeIds(scopes), [IMPL_REPO, bridgeId]);
	assert.match(
		scopes,
		new RegExp(`- ${bridgeId}:\\n      ref: [0-9a-f]{40}\\n      work-branch: work/kb\\n`),
		"the bridge scope lands where a kb-feat dive's does",
	);

	assertOk(run(["jump", divePath], bridge), "jump failed");
	const self = join(bridge, "workspace", "__self");
	const made = run(["crud", "memo", "--name", "notes", "Notes"], bridge);
	assertOk(made, "crud memo failed");
	const memoId = /Minted \S*?([0-9a-f-]{36})\.md/.exec(made.stdout)?.[1];
	assert.ok(existsSync(join(self, "kb", `${memoId}.md`)), "written in __self");
	assert.ok(!existsSync(join(bridge, "kb", `${memoId}.md`)), "not in the live bridge");
});

test("a dive on a feat that already scopes the bridge scopes it once", () => {
	const { bridge } = seededBridge(tmp, "once", "pilot@nosedive.invalid");
	const recorded = run(["crud", "dive", "--feat", KB_FEAT, "Once"], bridge, "Once.\n");
	assertOk(recorded, "crud dive failed");
	const text = readFileSync(join(bridge, /^Recorded (\S+)$/m.exec(recorded.stdout)[1]), "utf8");
	assert.equal(scopeIds(text.slice(0, text.indexOf("meta:"))).length, 1);
});

test("a bridge naming no bridge repo records dives as before", () => {
	const { bridge, featId } = bridgeWithImplFeat("no-bridge-key");
	const configPath = join(bridge, ".nosedive", "config.yaml");
	writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/^bridge: \S+\n/m, ""));
	runTool("git", ["commit", "-am", "drop the bridge key"], bridge);
	const recorded = run(["record.dive", "--feat", featId], bridge);
	assertOk(recorded, "record.dive failed");
	const text = readFileSync(join(bridge, /^Recorded (\S+)$/m.exec(recorded.stdout)[1]), "utf8");
	assert.deepEqual(scopeIds(text.slice(0, text.indexOf("meta:"))), [IMPL_REPO]);
});

test("a second dive on the bridge lands only its own work, after the first landed through a merge", () => {
	const { bridge, origin } = seededBridge(tmp, "self-twice", "pilot@nosedive.invalid");
	const dive = (name) => {
		assertOk(run(["jump", KB_FEAT], bridge), "jump failed");
		assertOk(run(["crud", "memo", "--name", name, name], bridge), "crud memo failed");
		// Edit the dived feat too: the first dive's bookkeeping touched it, and so did jump's.
		assertOk(
			run(["crud", KB_FEAT, "--meta", "-"], bridge, `note: ${name}\n`),
			"crud --meta on the kb feat failed",
		);
		const landed = run(["land"], bridge);
		assertOk(landed, `land of ${name} failed`);
	};
	dive("first");
	dive("second");
	const published = git(["log", "--format=%s", "main"], origin);
	assert.equal(published.match(/created memo first/g)?.length, 1, "the first memo lands once");
	assert.equal(published.match(/created memo second/g)?.length, 1);
	assert.equal(git(["status", "--porcelain", "--", ".nosedive", "kb"], bridge), "");
});
