import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, libUrl, seededBridge } from "../test-helpers.mjs";

const { pruneHelmLogs } = await import(libUrl);
const tmp = createTmp("helm-log");

const dayBefore = (now, days) =>
	new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);

test("helm prunes its daily logs past 14 days and leaves anything else", () => {
	const { bridge } = seededBridge(tmp, "logs", "pilot@nosedive.invalid");
	const logs = join(bridge, ".nosedive", "logs");
	mkdirSync(logs, { recursive: true });
	const now = new Date();
	const old = join(logs, `helm-${dayBefore(now, 20)}.log`);
	const recent = join(logs, `helm-${dayBefore(now, 3)}.log`);
	const other = join(logs, "notes.txt");
	for (const file of [old, recent, other]) writeFileSync(file, "x\n");

	pruneHelmLogs(bridge, now);
	assert.equal(existsSync(old), false, "a log from 20 days ago is pruned");
	assert.ok(existsSync(recent), "a log from 3 days ago stays");
	assert.ok(existsSync(other), "an unrelated file stays");
});
