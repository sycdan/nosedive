import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, gitCommit, libUrl, runTool, seededBridge } from "../test-helpers.mjs";

const { assertBridgeInStep } = await import(libUrl);
const tmp = createTmp("bridge-in-step");
const git = (args, cwd) => runTool("git", args, cwd).stdout.trim();

function commit(dir, file, message) {
	writeFileSync(join(dir, file), `${message}\n`);
	runTool("git", ["add", file], dir);
	gitCommit(dir, message);
}

test("assertBridgeInStep refuses only a bridge diverged from its upstream", () => {
	const { bridge } = seededBridge(tmp, "in-step", "pilot@nosedive.invalid");
	commit(bridge, "a.txt", "pushed");
	git(["push", "-q"], bridge);

	commit(bridge, "b.txt", "ahead");
	assert.doesNotThrow(() => assertBridgeInStep(bridge), "ahead is fine");
	git(["reset", "-q", "--hard", "HEAD~2"], bridge);
	assert.doesNotThrow(() => assertBridgeInStep(bridge), "behind is fine");

	commit(bridge, "c.txt", "elsewhere");
	assert.throws(
		() => assertBridgeInStep(bridge),
		/^Error: bridge main has diverged from origin\/main; push it or pull first, then retry$/,
	);
});
