import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
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

const tmp = createTmp("self-gates");
const FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";
// Minted with nosedive mint for this dive.
const GATE = "01a11b71-d4f2-764e-9cf1-dcf44120c473";
const script = (passes) =>
	`export function run() { console.error("self gate ${passes}"); return ${passes}; }\n`;
const gateDoc = `---\nkind: memo\nid: ${GATE}\nname: self-check\nscopes: []\nmeta:\n  test-script: kb/artifacts/${GATE}.mjs\n---\n`;
const edges = `  - kb/${GATE}.md:\n      rel: land.gate\n  - kb/${GATE}.md:\n      rel: test.gate\n`;
function commit(root) {
	runTool("git", ["add", "."], root);
	gitCommit(root, "gate fixture");
}
function putGate(root) {
	write(join(root, "kb", `${GATE}.md`), gateDoc);
	const path = join(root, "kb", `${FEAT}.md`);
	const text = readFileSync(path, "utf8");
	write(
		path,
		text.includes("links:\n")
			? text.replace("links:\n", `links:\n${edges}`)
			: text.replace(/\n---\n/, `\nlinks:\n${edges}---\n`),
	);
}
function setup(name, initial) {
	const { bridge } = seededBridge(tmp, name, "pilot@nosedive.invalid");
	if (initial !== undefined) {
		putGate(bridge);
		write(join(bridge, "kb", "artifacts", `${GATE}.mjs`), script(initial));
		commit(bridge);
	}
	assertOk(runTool("git", ["push"], bridge), "push fixture");
	const recorded = run(
		["crud", "dive", "--feat", FEAT, "Change", "gate"],
		bridge,
		"Check self gates.\n",
	);
	assertOk(recorded, "record");
	const divePath = /^Recorded (\S+)$/m.exec(recorded.stdout)[1];
	assertOk(run(["jump", divePath], bridge), "jump");
	return { bridge, self: join(bridge, "workspace", "__self"), divePath };
}
for (const passes of [true, false]) {
	test(`land and test execute the dive's ${passes ? "fixed" : "broken"} bridge gate`, () => {
		const { bridge, self, divePath } = setup(`changed-${passes}`, !passes);
		const artifact = join("kb", "artifacts", `${GATE}.mjs`);
		write(join(self, artifact), script(passes));
		commit(self);
		const checked = run(["test", "--full"], bridge);
		assert.equal(checked.status === 0, passes, checked.stderr);
		assert.match(checked.stderr + checked.stdout, new RegExp(`self gate ${passes}`));
		assert.equal(readFileSync(join(bridge, artifact), "utf8"), script(!passes));
		const landed = run(["land"], bridge);
		assert.equal(landed.status === 0, passes, landed.stderr);
		assert.match(landed.stdout, /changed on this dive/);
		assert.match(readFileSync(join(bridge, divePath), "utf8"), /changed on this dive/);
		assert.equal(readFileSync(join(bridge, artifact), "utf8"), script(passes ? passes : !passes));
	});
}
test("a gate added on the dive runs before anything enters the bridge", () => {
	const { bridge, self } = setup("added");
	putGate(self);
	write(join(self, "kb", "artifacts", `${GATE}.mjs`), script(false));
	commit(self);
	const result = run(["land"], bridge);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /self gate false/);
	assert.match(result.stdout, /changed on this dive/);
	assert.throws(() => readFileSync(join(bridge, "kb", `${GATE}.md`)));
	assert.notEqual(run(["test", `kb/${GATE}.md`], bridge).status, 0);
});
test("a gate deleted on the dive is no longer selected", () => {
	const { bridge, self } = setup("deleted", false);
	const feat = join(self, "kb", `${FEAT}.md`);
	write(feat, readFileSync(feat, "utf8").replace(edges, ""));
	rmSync(join(self, "kb", `${GATE}.md`));
	rmSync(join(self, "kb", "artifacts", `${GATE}.mjs`));
	commit(self);
	const result = run(["land"], bridge);
	assertOk(result, "deleted gate land");
	assert.doesNotMatch(result.stderr, /self gate false/);
});
