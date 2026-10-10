import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	run,
	runTool,
	seededBridge,
	write,
} from "../test-helpers.mjs";

const tmp = createTmp("repo-create");
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";
const GATE = "00000000-0000-7d9b-bd90-df6c304acccb";

const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

/** A jumped dive on the kb feat that has minted repo `name`, its local remote `../<name>` unless given. */
function diveWithRepo(bridge, name, local = `../${name}`) {
	const recorded = run(
		["record.dive", "--feat", KB_FEAT, "--gist", ["Add", name].join(" "), "--brief", "-"],
		bridge,
		"Add a repo.\n",
	);
	assertOk(recorded, "crud dive failed");
	assertOk(run(["jump", /^Recorded (\S+)$/m.exec(recorded.stdout)[1]], bridge), "jump failed");
	const minted = run(
		["crud", "repo", "--name", name, "--meta", "-", `The ${name} repo`],
		bridge,
		`remotes:\n  local: ${local}\n`,
	);
	assertOk(minted, "crud repo failed");
	const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(minted.stdout)[1];
	return { id, target: join(tmp, `${name}.git`) };
}

/** A bare repo at `target` whose one commit holds `files`. */
function repoAt(target, files) {
	const source = `${target}-source`;
	runTool("git", ["init", "-b", "main", source], tmp);
	for (const [path, text] of Object.entries(files)) write(join(source, path), text);
	runTool("git", ["add", "-A"], source);
	gitCommit(source, "elsewhere");
	runTool("git", ["clone", "--bare", source, target], tmp);
}

test("a repo doc minted on a dive brings the repo-create gate, which makes the repo at land; it then hydrates", () => {
	const { bridge, origin } = seededBridge(tmp, "create", "pilot@nosedive.invalid");
	const { id, target } = diveWithRepo(bridge, "cards");
	const dive = readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8").match(
		/[0-9a-f-]{36}/,
	)[0];
	assert.match(
		readFileSync(join(bridge, "kb", `${dive}.md`), "utf8"),
		new RegExp(`^  - kb/${GATE}\\.md:\\n      rel: land\\.gate$`, "m"),
	);
	assert.ok(!existsSync(join(bridge, "kb", `${GATE}.md`)), "the gate is never copied in");

	const landed = run(["land"], bridge);
	assertOk(landed, "land failed");
	assert.match(landed.stderr, /repo-create: created repo cards/);
	assert.match(git(["show", "main:kb/" + id + ".md"], origin), /^ {4}local: \.\.\/cards$/m);

	// The new repo is a bridge of its own, seeded with the repo doc's id and name.
	const show = (path) => git(["--git-dir", target, "show", `main:${path}`], tmp);
	const config = show(".nosedive/config.yaml");
	assert.match(config, new RegExp(`^bridge: ${id}$`, "m"));
	assert.match(show(`kb/${id}.md`), /^name: cards$/m);
	const backlog = /^backlog: (\S+)$/m.exec(config)[1];
	assert.match(show(`kb/${backlog}.md`), new RegExp(`^scopes:\n  - ${id}:$`, "m"));
	assert.match(show(`kb/${KB_FEAT}.md`), new RegExp(`^  - ${id}:$`, "m"));
	const files = git(["--git-dir", target, "ls-tree", "-r", "--name-only", "main"], tmp);
	assert.doesNotMatch(files, /AGENTS\.md|\.nosedive-ref|\.gitkeep/);

	assertOk(run(["hydrate-repo.workspace", id], bridge), "hydrate failed");
	assert.match(
		readFileSync(join(bridge, "workspace", "cards", ".nosedive", "config.yaml"), "utf8"),
		new RegExp(`^bridge: ${id}$`, "m"),
	);
});

test("{id} in a repo's remotes is minted as the doc's id, and land creates the repo there", () => {
	const { bridge } = seededBridge(tmp, "by-id", "pilot@nosedive.invalid");
	const { id } = diveWithRepo(bridge, "ledger", "../repos/{id}");
	const doc = readFileSync(join(bridge, "workspace", "__self", "kb", `${id}.md`), "utf8");
	assert.match(doc, new RegExp(`^ {4}local: \\.\\./repos/${id}$`, "m"));
	assertOk(run(["land"], bridge), "land failed");
	assert.ok(existsSync(join(tmp, "repos", `${id}.git`)), "the bare repo is named by id");
});

test("the gate keeps a repo whose trunk is already the bridge of the same doc", () => {
	const { bridge } = seededBridge(tmp, "reuse", "pilot@nosedive.invalid");
	const { id, target } = diveWithRepo(bridge, "decks");
	repoAt(target, { ".nosedive/config.yaml": `bridge: ${id}\n` });
	const head = git(["--git-dir", target, "rev-parse", "main"], tmp);

	const landed = run(["land"], bridge);
	assertOk(landed, "land failed");
	assert.match(landed.stderr, /repo-create: repo decks .* already exists; kept/);
	assert.equal(git(["--git-dir", target, "rev-parse", "main"], tmp), head);
});

test("the gate refuses something else at the target before land pushes anything", () => {
	const { bridge, origin } = seededBridge(tmp, "refuse", "pilot@nosedive.invalid");
	const { target } = diveWithRepo(bridge, "binders");
	repoAt(target, { "README.md": "somebody else's\n" });
	const published = () => git(["for-each-ref", "--format=%(refname) %(objectname)"], origin);
	const before = published();

	const refused = run(["land"], bridge);
	assert.equal(refused.status, 1, refused.stderr);
	assert.match(refused.stderr, /a repository is there whose main is no bridge/);
	assert.match(refused.stderr, /gates did not pass; nothing was pushed/);
	assert.equal(published(), before, "nothing reached the bridge's origin");
	assert.ok(existsSync(join(bridge, "workspace", ".nosedive-ref")), "the dive stays open");
});
