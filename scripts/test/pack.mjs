import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	packageVersionPattern,
	run,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("pack");
const backlogId = "019fcf00-0000-7000-8000-00000000000b";

function bareRemote(name) {
	const path = join(tmp, name);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], path);
	return path;
}

function sourceRepo(name) {
	const path = join(tmp, name);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "-b", "main"], path);
	write(join(path, "README.md"), "base\n");
	runTool("git", ["add", "README.md"], path);
	gitCommit(path, "base");
	return path;
}

function setup(name, diver = "pack@example.test") {
	const origin = bareRemote(`${name}-origin.git`);
	const source = sourceRepo(`${name}-source`);
	const bridge = join(tmp, name);
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Pack Test"], bridge);
	runTool("git", ["config", "user.email", "pack@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: backlogId });

	const repoId = "019fcf00-0000-7000-8000-000000000001";
	const effortId = "019fcf00-0000-7000-8000-000000000002";
	write(
		join(bridge, "kb", `${repoId}.md`),
		`---
kind: repo
id: ${repoId}
name: ${name}-repo
gist: "Pack test scoped repo"
meta:
  path: workspace/${name}-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
---
`,
	);
	write(
		join(bridge, "kb", `${effortId}.md`),
		`---
kind: feat
id: ${effortId}
name: pack-test.nosedive
gist: "Pack test effort"
scopes:
  - ${repoId}:
      work-branch: work/pack-test.nosedive
---

# Pack Test
`,
	);
	// A dive is only pickable back up if the deck reaches its feat, and putting
	// the dive down is the whole point of packing.
	write(
		join(bridge, "kb", `${backlogId}.md`),
		`---
kind: memo
id: ${backlogId}
name: pack-test-backlog
gist: "Pack test backlog"
links:
  - kb/${effortId}.md:
      rel: child.feat
---

# Backlog
`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "initial bridge state");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);

	assertOk(run(["hydrate-repo.workspace", repoId], bridge), "hydrate scoped repo failed");
	const diveResult = run(
		["record.dive", "--effort", effortId, ...(diver ? ["--diver", diver] : [])],
		bridge,
	);
	assertOk(diveResult, "record.dive failed");
	const diveId = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(diveResult.stdout)?.[1];
	assert.ok(diveId, `record.dive did not report a dive id:\n${diveResult.stdout}`);
	// record.dive also writes the effort's reciprocal link; on a real bridge jump
	// commits both, so start from that state rather than pre-loading bridge WIP.
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "record dive");
	if (!diver) write(join(bridge, "workspace", ".nosedive-ref"), `id: ${diveId}\n`);

	return { bridge, origin, source, repoId, effortId, diveId };
}

function repoWorktree(bridge, name) {
	return join(bridge, "workspace", `${name}-repo`);
}

function splitDoc(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	assert.ok(match, `expected frontmatter in:\n${text}`);
	return { yaml: match[1], body: text.slice(match[0].length) };
}

function readMemo(bridge, relPath) {
	const text = readFileSync(join(bridge, relPath), "utf8");
	const { yaml, body } = splitDoc(text);
	return {
		kind: /^kind: (.+)$/m.exec(yaml)?.[1],
		id: /^id: (.+)$/m.exec(yaml)?.[1],
		name: /^name: (.+)$/m.exec(yaml)?.[1],
		gist: (/^gist: "(.*)"$/m.exec(yaml) ?? /^gist: (.+)$/m.exec(yaml))?.[1],
		patch: /^ {2}patch: (.+)$/m.exec(yaml)?.[1],
		next: /- (kb\/[0-9a-f-]{36}\.md):\n\s+rel: next/.exec(yaml)?.[1],
		body: body.trim(),
	};
}

function patchHeadsByRel(diveText, rel) {
	return [
		...diveText.matchAll(new RegExp(`- (kb\\/[0-9a-f-]{36}\\.md):\\n\\s+rel: ${rel}`, "g")),
	].map((match) => match[1]);
}

/**
 * A dive captures bridge `kb/` WIP only in docs it links, so a test that wants
 * a doc captured has to say so on the dive the way a pilot would -- a link.
 */
function addDiveLink(bridge, diveId, target, rel = "related") {
	const path = join(bridge, "kb", `${diveId}.md`);
	const { yaml, body } = splitDoc(readFileSync(path, "utf8"));
	const entry = `  - ${target}:\n      rel: ${rel}`;
	const linked = /^links:$/m.test(yaml)
		? yaml.replace(/^links:$/m, `links:\n${entry}`)
		: `${yaml}\nlinks:\n${entry}`;
	write(path, `---\n${linked}\n---\n${body}`);
}

/** A doc has to be tracked before dirtying it proves anything about capture. */
function commitMemo(bridge, relPath, id, gist) {
	write(join(bridge, relPath), `---\nkind: memo\nid: ${id}\nname: ${id}\ngist: "${gist}"\n---\n`);
	runTool("git", ["add", "--", relPath], bridge);
	gitCommit(bridge, `add ${relPath}`);
	runTool("git", ["push"], bridge);
}

test("pack requires an active dive marker", () => {
	const bridge = join(tmp, "no-marker");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb" });
	mkdirSync(join(bridge, "workspace"), { recursive: true });
	const result = run(["pack"], bridge);
	assert.notEqual(result.status, 0, "pack without a dive marker unexpectedly succeeded");
	assert.match(result.stderr, /^nosedive-error: \S/m);
	assert.match(result.stderr, /render 019fe2f7-5922-72d5-abda-b5b8cb7300cf/);
});

test("pack captures ahead commits, dirty state, bridge-wip, pushes, and resets", () => {
	const { bridge, origin, repoId, effortId, diveId } = setup("full");
	const worktree = repoWorktree(bridge, "full");
	assertOk(
		run(["record.dive", "--ref", diveId, "--brief", "Exercise pack after jump."], bridge),
		"record.dive brief failed",
	);
	assertOk(run(["jump"], bridge), "jump failed");

	write(join(worktree, "feature-a.txt"), "a\n");
	runTool("git", ["add", "feature-a.txt"], worktree);
	gitCommit(worktree, "add feature a");
	write(join(worktree, "feature-b.txt"), "b\n");
	runTool("git", ["add", "feature-b.txt"], worktree);
	gitCommit(worktree, "add feature b");

	write(join(worktree, "README.md"), "base\nedited\n");
	write(join(worktree, "untracked.txt"), "untracked\n");

	const effortPath = join(bridge, "kb", `${effortId}.md`);
	write(effortPath, `${readFileSync(effortPath, "utf8")}\nExtra bridge WIP line.\n`);

	// The dive links this memo, so its dirty state is the dive's to carry.
	const linkedId = "01a024ef-1cef-7ca8-adfb-753b56c6c2ac";
	commitMemo(bridge, `kb/${linkedId}.md`, linkedId, "Linked bridge memo");
	addDiveLink(bridge, diveId, `kb/${linkedId}.md`);
	const linkedPath = join(bridge, "kb", `${linkedId}.md`);
	write(linkedPath, `${readFileSync(linkedPath, "utf8")}\nExtra linked WIP line.\n`);

	const stray = join(bridge, "stray.txt");
	write(stray, "unrelated bridge dirty file\n");

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: 4 artifact\\(s\\)`));
	assert.match(
		result.stdout,
		new RegExp(`reset repo=${repoId} path=workspace/full-repo ref=[0-9a-f]{40}`),
	);
	assert.equal(existsSync(worktree), true, "scoped repo should remain hydrated after pack");
	assert.match(
		result.stdout,
		new RegExp(`^nosedive jump kb/${diveId}\\.md$`, "m"),
		"pack should end by naming jump on the packed dive",
	);
	const pin = /^\s+ref: ([0-9a-f]{40})$/m.exec(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
	)?.[1];
	assert.ok(pin, "dive should retain a scope pin");
	assert.equal(runTool("git", ["rev-parse", "HEAD"], worktree).stdout.trim(), pin);
	assert.equal(runTool("git", ["status", "--porcelain"], worktree).stdout, "");
	assert.equal(existsSync(join(worktree, ".nosedive-ref")), true, "managed marker should remain");

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.match(diveText, /^  diver: null$/m, "pack should release the dive");
	assert.match(
		readFileSync(join(bridge, "kb", `${effortId}.md`), "utf8"),
		new RegExp(`- kb/${diveId}\\.md:\\n      rel: packed\\.dive`),
	);
	const patchHeads = patchHeadsByRel(diveText, "patch");
	assert.equal(patchHeads.length, 2, `expected 2 patch chain heads:\n${diveText}`);

	// Walk the repo chain from its head via `rel: next` -- order is the chain, not array position.
	const repoChainHead = patchHeads.find((head) =>
		readMemo(bridge, head).name.endsWith("full-repo"),
	);
	assert.ok(repoChainHead, `expected a repo patch chain head:\n${diveText}`);
	const commitA = readMemo(bridge, repoChainHead);
	assert.equal(commitA.kind, "memo");
	assert.match(commitA.name, /^[0-9a-f]{12}\.full-repo$/);
	assert.equal(commitA.gist, "add feature a");
	assert.match(commitA.body, new RegExp(`Feat: ${effortId}`));
	assert.match(
		commitA.body,
		new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern} <noreply@nosedive\\.dev>`),
	);
	assert.ok(commitA.next, "commit A memo should link the next memo");

	const commitB = readMemo(bridge, commitA.next);
	assert.match(commitB.name, /^[0-9a-f]{12}\.full-repo$/);
	assert.equal(commitB.gist, "add feature b");
	assert.ok(commitB.next, "commit B memo should link the next memo");

	const dirty = readMemo(bridge, commitB.next);
	assert.equal(dirty.name, "dirty.full-repo");
	assert.equal(dirty.gist, "Uncommitted working-tree changes.");
	assert.equal(dirty.next, undefined, "dirty memo should be the end of the chain");

	const bridgeWipHead = patchHeads.find((head) => head !== repoChainHead);
	const bridgeWip = readMemo(bridge, bridgeWipHead);
	assert.match(bridgeWip.name, /^bridge-wip\.[0-9a-f]{6}$/);
	assert.equal(bridgeWip.gist, "Uncommitted bridge kb/ changes.");
	assert.equal(bridgeWip.next, undefined);

	const commitAPatch = readFileSync(join(bridge, commitA.patch), "utf8");
	assert.match(commitAPatch, /Subject: \[PATCH\] add feature a/);
	assert.match(commitAPatch, /\+a/);
	// `gitRun` trims stdout; a captured patch went through that for a while,
	// silently stripping the trailing newline `format-patch` always ends
	// with (and, worse, a trailing whitespace-only context line when one
	// exists) -- both make `git am`/`git apply` reject the patch as corrupt.
	assert.match(commitAPatch, /\n$/, "captured commit patch must keep its trailing newline");

	const dirtyPatch = readFileSync(join(bridge, dirty.patch), "utf8");
	assert.match(dirtyPatch, /\+edited/);
	assert.match(dirtyPatch, /untracked\.txt/);
	assert.match(dirtyPatch, /\n$/, "captured dirty diff must keep its trailing newline");

	const bridgeWipPatch = readFileSync(join(bridge, bridgeWip.patch), "utf8");
	assert.match(bridgeWipPatch, /Extra linked WIP line\./);
	// The feat doc is the dive's parent, never its cargo: pack excludes it from
	// the capture and lets `commitAndPushPack` stage it alongside the dive.
	assert.doesNotMatch(bridgeWipPatch, /Extra bridge WIP line\./);
	assert.match(bridgeWipPatch, /\n$/, "captured bridge-wip diff must keep its trailing newline");

	const log = runTool("git", ["log", "-1", "--format=%s"], bridge).stdout.trim();
	assert.equal(log, `dive(${diveText.match(/^name: (.+)$/m)[1]}): packed wip`);
	const commitBody = runTool("git", ["log", "-1", "--format=%B"], bridge).stdout;
	assert.match(commitBody, new RegExp(`Feat: ${effortId}`));
	assert.match(
		commitBody,
		new RegExp(`Co-Authored-By: nosedive ${packageVersionPattern} <noreply@nosedive\\.dev>`),
	);
	assert.equal((commitBody.match(/Co-Authored-By: nosedive /g) ?? []).length, 1);

	const bridgeHead = runTool("git", ["rev-parse", "main"], bridge).stdout.trim();
	const originHead = runTool("git", ["rev-parse", "main"], origin).stdout.trim();
	assert.equal(bridgeHead, originHead, "pack should push the bridge to its remote");
	assert.equal(
		runTool("git", ["status", "--porcelain", "--", `kb/${effortId}.md`], bridge).stdout,
		"",
		"pack should stage its effort rel rewrite",
	);

	const strayStatus = runTool("git", ["status", "--porcelain", "--", "stray.txt"], bridge).stdout;
	assert.match(
		strayStatus,
		/^\?\? stray\.txt/m,
		"unrelated dirty file should be restored, not committed",
	);
	assert.equal(readFileSync(stray, "utf8"), "unrelated bridge dirty file\n");
});

/**
 * Who put the dive down is the half of a handoff nothing recorded: the diver
 * went to null and no field said whose null it was.
 */
test("pack moves the dive's diver to its packer", () => {
	const { bridge, diveId } = setup("packer");
	const result = run(["pack"], bridge);
	assertOk(result, "pack failed");
	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.match(diveText, /^  diver: null$/m, "pack should release the dive");
	assert.match(
		diveText,
		/^  packer: "?pack@example\.test"?$/m,
		"pack should record who put the dive down",
	);
});

/**
 * A dive nobody holds is not the dive the workspace is on. Leaving the marker
 * behind left `append-log.dive`, `spin` and `land` reading an active dive that
 * had already been handed back.
 */
test("pack removes the workspace dive marker", () => {
	const { bridge } = setup("marker");
	const marker = join(bridge, "workspace", ".nosedive-ref");
	assert.equal(existsSync(marker), true, "the fixture must start with an active dive");
	assertOk(run(["pack"], bridge), "pack failed");
	assert.equal(existsSync(marker), false, "pack should leave no active dive");
	// Proved by the command that needs one: with no marker there is nothing to pack.
	const again = run(["pack"], bridge);
	assert.notEqual(again.status, 0, "a second pack with no active dive unexpectedly succeeded");
});

test("a packed dive reaches jump and reapplies its patch chain", () => {
	const { bridge, diveId } = setup("resume");
	const worktree = repoWorktree(bridge, "resume");
	assertOk(run(["record.dive", "--ref", diveId, "--brief", "Resume packed work."], bridge));
	write(join(worktree, "resumed.txt"), "resumed\n");
	runTool("git", ["add", "resumed.txt"], worktree);
	gitCommit(worktree, "resume me");
	assertOk(run(["pack"], bridge), "pack failed");
	// Named, not bare: pack put the dive down, so there is no dive on deck for a
	// bare `jump` to re-run.
	assertOk(run(["jump", diveId], bridge), "jump failed after pack");
	assert.equal(readFileSync(join(worktree, "resumed.txt"), "utf8"), "resumed\n");
	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	assert.doesNotMatch(diveText, /rel: patch/);
});

test("pack refuses a read-only scope with unpacked work", () => {
	const { bridge, effortId, diveId } = setup("readonly");
	const roRepoId = "019fcf00-0000-7000-8000-000000000003";
	const source = sourceRepo("readonly-ro-source");
	write(
		join(bridge, "kb", `${roRepoId}.md`),
		`---
kind: repo
id: ${roRepoId}
name: readonly-ro-repo
gist: "Read-only pack test repo"
meta:
  path: workspace/readonly-ro-repo
  trunk: main
  remotes:
    local: ${source.replaceAll("\\", "/")}
---
`,
	);
	assertOk(
		run(["hydrate-repo.workspace", roRepoId, "--read-only"], bridge),
		"hydrate read-only repo failed",
	);
	assertOk(
		run(["record.dive", "--ref", diveId, "--upscope", roRepoId], bridge),
		"scoping read-only repo onto dive failed",
	);
	/**
	 * Scoping a repo is an explicit request for somewhere to put its work, so it
	 * arrives with a branch. Taking that branch away is what makes it read-only,
	 * and the hydrate flag only picks which sentinel a rejected push cites.
	 */
	const roDivePath = join(bridge, "kb", `${diveId}.md`);
	write(
		roDivePath,
		readFileSync(roDivePath, "utf8").replace(
			new RegExp(`(  - ${roRepoId}:\\n      ref: [0-9a-f]{40}\\n)      work-branch: .*\\n`),
			"$1",
		),
	);

	// The new repo doc is a bridge kb/ edit the dive does not link, and pack now
	// refuses those ahead of the scope loop -- publish it the way a pilot would,
	// so the read-only refusal below is the one under test.
	runTool("git", ["add", "--", "kb"], bridge);
	gitCommit(bridge, "publish the read-only repo doc");

	const roWorktree = repoWorktree(bridge, "readonly-ro");
	write(join(roWorktree, "dirty.txt"), "dirty\n");

	const result = run(["pack"], bridge);
	assert.notEqual(result.status, 0, "pack over a dirty read-only scope unexpectedly succeeded");
	assert.match(result.stderr, new RegExp(`read-only scoped repo ${roRepoId} has unpacked work`));
	assert.equal(existsSync(roWorktree), true, "read-only scope should be left alone on refusal");
	void effortId;
});

test("pack with nothing to capture still resets and reports no-op", () => {
	const { bridge, repoId, diveId } = setup("clean");
	const worktree = repoWorktree(bridge, "clean");
	const beforeHead = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed on a clean scope");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: nothing to pack`));
	assert.match(result.stdout, new RegExp(`reset repo=${repoId}`));
	assert.equal(existsSync(worktree), true);
	assert.equal(runTool("git", ["status", "--porcelain"], worktree).stdout, "");
	assert.notEqual(
		runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim(),
		beforeHead,
		"releasing a held dive should create a bridge commit",
	);
});

test("pack without work or a diver leaves its phase alone", () => {
	const { bridge, effortId, diveId } = setup("unclaimed-clean", null);
	runTool("git", ["add", "--", "workspace/.nosedive-ref"], bridge);
	gitCommit(bridge, "activate unclaimed dive");
	runTool("git", ["push"], bridge);

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed on an unclaimed clean dive");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: nothing to pack`));
	assert.match(
		readFileSync(join(bridge, "kb", `${effortId}.md`), "utf8"),
		new RegExp(`- kb/${diveId}\\.md:\\n      rel: planned\\.dive`),
	);
});

test("pack captures bridge kb/ WIP whose filename needs quoting under plain --porcelain", () => {
	const { bridge, effortId, diveId } = setup("spacey");

	// Plain `git status --porcelain` (no `-z`) C-quotes a path like this by
	// default (`core.quotePath`), which `split(/\r?\n/)` + `slice(3)` cannot
	// undo -- the file would be silently dropped from bridge-wip capture.
	const spaceyPath = join(bridge, "kb", "space name.md");
	write(spaceyPath, "kind: memo\ngist: has a space in its filename\n");
	// Capture is now narrowed to what the dive links, so the spacey doc has to
	// be linked for the `-z` parsing this test exists for to be reached at all.
	addDiveLink(bridge, diveId, "kb/space name.md");

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed to capture a spacey-filename bridge-wip change");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: 1 artifact\\(s\\)`));

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const patchHeads = patchHeadsByRel(diveText, "patch");
	assert.equal(patchHeads.length, 1, `expected 1 patch chain head:\n${diveText}`);

	const bridgeWip = readMemo(bridge, patchHeads[0]);
	assert.match(bridgeWip.name, /^bridge-wip\.[0-9a-f]{6}$/);
	const patchText = readFileSync(join(bridge, bridgeWip.patch), "utf8");
	assert.match(patchText, /space name\.md/);
	assert.match(patchText, /has a space in its filename/);
	void effortId;
});

test("pack ignores unlinked dirty bridge kb docs with warning", () => {
	const { bridge, diveId } = setup("unlinked");
	// Dirty the scoped repo so pack mints a `.patch` into kb/ for it
	write(join(repoWorktree(bridge, "unlinked"), "dirty.txt"), "dirty\n");
	const strayId = "019fcf00-0000-7000-8000-00000000000c";
	write(join(bridge, "kb", `${strayId}.md`), `---\nkind: memo\nid: ${strayId}\n---\n`);

	const result = run(["pack"], bridge);
	assertOk(result, "pack should warn and keep going when dirty bridge docs are unlinked");
	assert.match(result.stderr, new RegExp(`kb/${strayId}\\.md`));
	assert.match(result.stderr, /warning:/);
	assert.match(result.stderr, /ignoring/i);
	assert.equal(
		existsSync(join(bridge, "workspace", ".nosedive-ref")),
		false,
		"pack should release the dive",
	);
	assert.match(
		readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8"),
		/^\s+diver: null$/m,
		"pack should release the dive even when it ignores unlinked bridge WIP",
	);
});

test("pack bundles linked doc meta files like a gate test-script", () => {
	const { bridge, diveId } = setup("bundle-meta");
	const gateId = "019fcf00-0000-7000-8000-00000000000d";
	const scriptPath = join(bridge, "kb", "artifacts", "gate-test.mjs");
	mkdirSync(join(bridge, "kb", "artifacts"), { recursive: true });
	write(scriptPath, "export async function run() { return 0; }\n");
	write(
		join(bridge, "kb", `${gateId}.md`),
		`---\nkind: gate\nid: ${gateId}\nname: gate-test\ngist: gate bundle test\nmeta:\n  test-script: kb/artifacts/gate-test.mjs\n---\n`,
	);
	addDiveLink(bridge, diveId, `kb/${gateId}.md`, "test.gate");

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed while bundling linked gate metadata");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: 1 artifact\\(s\\)`));

	const diveText = readFileSync(join(bridge, "kb", `${diveId}.md`), "utf8");
	const heads = patchHeadsByRel(diveText, "patch");
	assert.equal(heads.length, 1, `expected 1 patch head:\n${diveText}`);
	const bridgeWip = readMemo(bridge, heads[0]);
	const patchText = readFileSync(join(bridge, bridgeWip.patch), "utf8");
	assert.match(patchText, /gate-test\.mjs/);
	assert.match(patchText, /export async function run\(\)/);
});

test("pack names every unlinked dirty kb/ doc at once", () => {
	const { bridge } = setup("unlinked-many");
	const firstId = "01a024ee-880f-7893-bfcc-a5629604f4dc";
	const secondId = "01a024ee-8810-7652-9444-c6023866a354";
	write(join(bridge, "kb", `${firstId}.md`), `---\nkind: memo\nid: ${firstId}\n---\n`);
	write(join(bridge, "kb", `${secondId}.md`), `---\nkind: memo\nid: ${secondId}\n---\n`);

	const result = run(["pack"], bridge);
	assertOk(result, "pack should warn and continue when several dirty bridge docs are unlinked");
	assert.match(result.stderr, new RegExp(`kb/${firstId}\\.md`));
	assert.match(result.stderr, new RegExp(`kb/${secondId}\\.md`));
	assert.match(result.stderr, /warning:/);
});

/**
 * The dive doc is dirty on every pack that follows a `--brief` or a `jump`, and
 * the feat doc is dirty whenever a rel was rewritten. Neither is cargo.
 */
test("pack counts neither the dive's own doc nor its feat as unlinked", () => {
	const { bridge, effortId, diveId } = setup("own-doc");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	write(divePath, `${readFileSync(divePath, "utf8")}\nExtra dive body line.\n`);
	const effortPath = join(bridge, "kb", `${effortId}.md`);
	write(effortPath, `${readFileSync(effortPath, "utf8")}\nExtra feat body line.\n`);

	const result = run(["pack"], bridge);
	assertOk(result, "pack over its own dirty dive and feat docs failed");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: nothing to pack`));
});

test("pack does not capture ignored dive scratch contents", () => {
	const { bridge, diveId } = setup("scratch");
	write(join(bridge, "workspace", ".scratch", diveId, "temp.txt"), "local temp only\n");

	const result = run(["pack"], bridge);
	assertOk(result, "pack failed with ignored scratch contents");
	assert.match(result.stdout, new RegExp(`packed dive ${diveId}: nothing to pack`));

	const artifactDir = join(bridge, "kb", "artifacts");
	if (existsSync(artifactDir)) {
		for (const name of readdirSync(artifactDir)) {
			assert.doesNotMatch(
				readFileSync(join(artifactDir, name), "utf8"),
				/local temp only/,
				"scratch contents must not appear in pack artifacts",
			);
		}
	}
	assert.equal(existsSync(join(bridge, "workspace", ".scratch", diveId, "temp.txt")), true);
});
