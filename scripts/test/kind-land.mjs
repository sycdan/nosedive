import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	createTmp,
	gitCommit,
	run,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const tmp = createTmp("kind-land");
const minted = run(["mint", "5"], tmp);
assertOk(minted, "mint failed");
const [BACKLOG, REPO, FEAT, CARD_KIND, CARD] = minted.stdout.trim().split(/\r?\n/);

function kindDoc(conditions, extra = []) {
	return [
		"---",
		"kind: kind",
		`id: ${CARD_KIND}`,
		"name: card",
		'gist: "A card"',
		"meta:",
		"  schema:",
		"    type: object",
		"    additionalProperties: false",
		"    properties:",
		"      condition:",
		`        enum: [${conditions.join(", ")}]`,
		...extra.map((line) => `      ${line}`),
		"---",
		"",
	].join("\n");
}

const cardDoc = (condition) =>
	`---\nkind: card\nid: ${CARD}\nname: bolt\ngist: "Lightning Bolt"\nmeta:\n  condition: ${condition}\n---\n`;

/** A pushable bridge whose feat scopes a repo that declares a card kind with one card. */
function fixture() {
	const origin = join(tmp, "origin.git");
	mkdirSync(origin, { recursive: true });
	runTool("git", ["init", "--bare", "-b", "main"], origin);
	const source = join(tmp, "source");
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "kb", `${CARD_KIND}.md`), kindDoc(["mint", "played"]));
	write(join(source, "kb", `${CARD}.md`), cardDoc("played"));
	runTool("git", ["add", "."], source);
	gitCommit(source, "cards");

	const bridge = join(tmp, "bridge");
	mkdirSync(bridge, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridge);
	runTool("git", ["config", "user.name", "Kind Test"], bridge);
	runTool("git", ["config", "user.email", "kind@example.test"], bridge);
	writeBridgeConfig(bridge, { workspace: "./workspace", kb: "./kb", backlog: BACKLOG });
	write(
		join(bridge, "kb", `${REPO}.md`),
		`---\nkind: repo\nid: ${REPO}\nname: cards\ngist: "Cards"\nmeta:\n  path: workspace/cards\n  trunk: main\n  remotes:\n    local: ${source.replaceAll("\\", "/")}\n---\n`,
	);
	write(
		join(bridge, "kb", `${FEAT}.md`),
		`---\nkind: feat\nid: ${FEAT}\nname: cards\ngist: "Cards"\nscopes:\n  - ${REPO}:\n      work-branch: work/cards\n---\n\n# Cards\n`,
	);
	write(
		join(bridge, "kb", `${BACKLOG}.md`),
		`---\nkind: memo\nid: ${BACKLOG}\nname: backlog\ngist: "Backlog"\nlinks:\n  - kb/${FEAT}.md:\n      rel: current.feat\n---\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "bridge");
	runTool("git", ["remote", "add", "origin", origin], bridge);
	runTool("git", ["push", "-u", "origin", "main"], bridge);
	return bridge;
}

/** Records a dive on the feat and jumps it, returning its scoped worktree. */
function jumpNewDive(bridge, gist) {
	const recorded = run(
		["record.dive", "--feat", FEAT, "--gist", gist, "--brief", "-"],
		bridge,
		gist,
	);
	assertOk(recorded, "record.dive failed");
	const id = /^Recorded kb[\\/]([0-9a-f-]{36})\.md$/m.exec(recorded.stdout)?.[1];
	runTool("git", ["add", "kb"], bridge);
	gitCommit(bridge, "record dive");
	assertOk(run(["jump", id], bridge), "jump failed");
	return join(bridge, "workspace", "cards");
}

function commitIn(worktree, path, text, message) {
	write(join(worktree, "kb", path), text);
	runTool("git", ["add", "."], worktree);
	gitCommit(worktree, message);
}

test("land refuses while an instance of a kind the dive changed fails its new schema", () => {
	const bridge = fixture();

	// Adding an optional field touches no doc and lands untouched.
	let worktree = jumpNewDive(bridge, "Track foils");
	commitIn(
		worktree,
		`${CARD_KIND}.md`,
		kindDoc(["mint", "played"], ["foil:", "  type: boolean"]),
		"foil",
	);
	const additive = run(["land"], bridge);
	assertOk(additive, "an additive schema change should land");

	// Removing an allowed value strands the card that uses it.
	worktree = jumpNewDive(bridge, "Mint only");
	commitIn(
		worktree,
		`${CARD_KIND}.md`,
		kindDoc(["mint"], ["foil:", "  type: boolean"]),
		"mint only",
	);
	const refused = run(["land"], bridge);
	assert.equal(refused.status, 1, refused.stdout);
	const said = refused.stdout + refused.stderr;
	assert.match(said, /fail(s)? (its|their) new schema/);
	assert.ok(said.includes(CARD), "names the failing doc");
	assert.match(said, /\/condition/);
	assert.match(
		readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"),
		/id: /,
		"still on the dive",
	);

	// Fixing the instance clears the way.
	commitIn(worktree, `${CARD}.md`, cardDoc("mint"), "bolt is mint");
	const landed = run(["land"], bridge);
	assertOk(landed, "land should pass once every card validates");
});
