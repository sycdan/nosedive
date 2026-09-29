import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const tmp = createTmp("dive-command");
const featId = "01a0ea70-0000-7000-8000-000000000001";
const diveId = "01a0ea70-0000-7000-8000-000000000002";
const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z`;

function bridgeWithFeat(name) {
	const bridge = createBridge(tmp, name);
	write(
		join(bridge, "kb", `${featId}.md`),
		`---\nkind: feat\nid: ${featId}\nname: notes\ngist: "Notes"\n---\n\n# Notes\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "feat");
	return bridge;
}

test("dive <feat> <gist...> records a dive with stdin as its brief, as record.dive does", () => {
	const bridge = bridgeWithFeat("records");
	const made = run(
		["dive", "notes", "--title", "Note button", "Add", "the", "note", "button"],
		bridge,
		"Put a Note button in the dive bar.\n\nIt takes free text.\n",
	);
	assertOk(made, "dive failed");
	const path = /^Recorded (\S+)$/m.exec(made.stdout)?.[1];
	assert.ok(path, made.stdout);
	const doc = readFileSync(join(bridge, path), "utf8");
	assert.match(doc, /^kind: dive$/m);
	assert.match(doc, /^gist: "Add the note button"$/m);
	assert.match(doc, new RegExp(`^  feat: ${featId}$`, "m"));
	assert.match(doc, /^# Note button$/m);
	assert.match(doc, /^## Brief\n\nPut a Note button in the dive bar\.\n\nIt takes free text\.$/m);
	assert.match(made.stdout, /^Committed dive\(notes\.\w+\): created$/m);
});

test("dive --log[:<event>] - appends stdin to the active dive, as append-log.dive does", () => {
	const bridge = bridgeWithFeat("logs");
	const divePath = join(bridge, "kb", `${diveId}.md`);
	write(
		divePath,
		`---\nkind: dive\nid: ${diveId}\nname: notes.000002\ngist: "Log something"\nmeta:\n  feat: ${featId}\n---\n\n# Log Something\n\n## Brief\n\nDo it.\n`,
	);
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${diveId}\n`);

	assertOk(run(["dive", "--log", "-"], bridge, "plain entry\n"), "dive --log failed");
	assertOk(run(["dive", "--log:built", "-"], bridge, "built it\n"), "dive --log:<event> failed");
	const doc = readFileSync(divePath, "utf8");
	assert.match(doc, new RegExp(`^## ${ISO}\\n\\nplain entry$`, "m"));
	assert.match(doc, new RegExp(`^## built ${ISO}\\n\\nbuilt it$`, "m"));
});

test("dive refuses what it cannot translate", () => {
	const bridge = bridgeWithFeat("refuses");
	for (const [args, pattern] of [
		[[], /Usage: nosedive dive/],
		[["notes"], /needs a feat and a gist/],
		[["--log"], /reads its body from stdin/],
		[["--log", "-", "extra"], /takes nothing else: extra/],
	]) {
		const refused = run(["dive", ...args], bridge, "");
		assert.equal(refused.status, 1, args.join(" "));
		assert.match(refused.stdout + refused.stderr, pattern);
	}
});
