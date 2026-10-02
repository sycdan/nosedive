import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createTmp, run, seededBridge } from "../test-helpers.mjs";

const tmp = createTmp("jump-feat");
const KB_FEAT = "00000000-0000-7003-a10b-25d64dd1d5ba";

test("jump <feat> records an unplanned dive on the feat and jumps it", () => {
	const { bridge } = seededBridge(tmp, "free", "pilot@nosedive.invalid");
	const before = readdirSync(join(bridge, "kb")).length;
	const rootId = /^backlog: (\S+)$/m.exec(
		readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"),
	)[1];

	const jumped = run(["jump", KB_FEAT, "--root", rootId], bridge);
	assertOk(jumped, "jump <feat> failed");
	const recorded = /^jump: recorded (\S+)$/m.exec(jumped.stderr)?.[1];
	assert.ok(recorded, jumped.stderr);
	assert.doesNotMatch(
		jumped.stdout + jumped.stderr,
		/Next steps:\s*nosedive jump/,
		"no advice to jump again",
	);
	assert.equal(readdirSync(join(bridge, "kb")).length, before + 1, "one dive recorded");

	const dive = readFileSync(join(bridge, recorded), "utf8");
	const id = /^id: (\S+)$/m.exec(dive)?.[1];
	const last6 = id.replaceAll("-", "").slice(-6);
	assert.match(dive, /^kind: dive$/m);
	assert.match(dive, new RegExp(`^name: ${KB_FEAT}\\.${last6}$`, "m"));
	assert.match(dive, /^gist: "Free dive on kb at \d{4}-\d\d-\d\dT\d\d:\d\dZ"$/m);
	assert.match(
		dive,
		new RegExp(`^# Kb ${last6}$`, "m"),
		"titled with its name, the feat's heading for an id-named feat",
	);
	assert.match(dive, /^## Brief\n\nAn unplanned dive into kb: no brief was written\.$/m);
	assert.match(dive, new RegExp(`^  root: ${rootId}$`, "m"), "the root it was jumped from");
	assert.doesNotMatch(dive, /^ {2}deck:/m, "only root is written");
	assert.match(
		readFileSync(join(bridge, "workspace", ".nosedive-ref"), "utf8"),
		new RegExp(`id: ${id}`),
	);
	assert.ok(
		existsSync(join(bridge, "workspace", "__self", "kb")),
		"the kb feat's scope is hydrated",
	);

	const again = run(["jump", KB_FEAT], bridge);
	assert.equal(again.status, 1);
	assert.match(again.stderr, /is active; land, pack or bail it/);
	const onDive = run(["jump", id, "--root", rootId], bridge);
	assert.equal(onDive.status, 1);
	assert.match(onDive.stderr, /jump --root goes with a feat, not a dive/);
	assert.equal(
		readdirSync(join(bridge, "kb")).length,
		before + 1,
		"a refused jump records nothing",
	);
});
