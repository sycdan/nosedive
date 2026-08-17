import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { assertOk, createBridge, createTmp, libUrl, run, write } from "../test-helpers.mjs";

const { decomposeSectionHeading } = await import(libUrl);

const tmp = createTmp("append-log");
const featId = "01a01060-0000-7000-8000-000000000002";
const diveId = "01a01060-0000-7000-8000-000000000003";

/** A bridge holding one dive, active unless `active` says otherwise. */
function setup(name, { kind = "dive", active = true } = {}) {
	const bridge = createBridge(tmp, name);
	write(
		join(bridge, "kb", `${featId}.md`),
		`---\nkind: feat\nid: ${featId}\nname: logging\ngist: "Logging"\n---\n\n# Logging\n`,
	);
	write(
		join(bridge, "kb", `${diveId}.md`),
		`---\nkind: ${kind}\nid: ${diveId}\nname: logging.000003\ngist: "Log something"\nmeta:\n  feat: ${featId}\n---\n\n# Log Something\n\n## Brief\n\nDo the thing.\n`,
	);
	if (active) write(join(bridge, "workspace", ".nosedive-ref"), `id: ${diveId}\n`);
	return { bridge, divePath: join(bridge, "kb", `${diveId}.md`) };
}

const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z`;

test("append-log.dive writes a timestamped section from stdin, and appends again on a second run", () => {
	const { bridge, divePath } = setup("appends");

	const first = run(["append-log.dive"], bridge, "commit abc123\ncommit def456\n");
	assertOk(first, "append-log.dive failed");
	assert.match(first.stdout, /^Logged to kb[/\\]/m);

	let doc = readFileSync(divePath, "utf8");
	assert.match(doc, new RegExp(`^## ${ISO}$`, "m"));
	assert.match(doc, /^commit abc123\ncommit def456$/m);
	// The brief is what informed the work; a log must never displace it.
	assert.match(doc, /^## Brief$/m);

	assertOk(run(["append-log.dive"], bridge, "second entry\n"), "second append failed");
	doc = readFileSync(divePath, "utf8");
	assert.equal(doc.match(new RegExp(`^## ${ISO}$`, "gm")).length, 2, "a log is a sequence");
	assert.ok(
		doc.indexOf("commit abc123") < doc.indexOf("second entry"),
		"entries must accumulate in the order they were written",
	);
});

test("append-log.dive puts --label in the heading and --gist above the body", () => {
	const { bridge, divePath } = setup("label-and-gist");

	const logged = run(
		["append-log.dive", "--label", "built", "--gist", "Both mutants caught; suite green."],
		bridge,
		"raw output line\n",
	);
	assertOk(logged, "append-log.dive with label and gist failed");

	const doc = readFileSync(divePath, "utf8");
	assert.match(doc, new RegExp(`^## built ${ISO}$`, "m"));
	assert.match(
		doc,
		new RegExp(`^## built ${ISO}\n\nBoth mutants caught; suite green\\.\n\nraw output line$`, "m"),
		"the gist belongs between the heading and the body",
	);
});

test("append-log.dive refuses what it cannot honestly record", () => {
	const { bridge } = setup("refusals");

	const empty = run(["append-log.dive"], bridge, "   \n\n");
	assert.notEqual(empty.status, 0);
	assert.match(empty.stderr, /refuses an empty section/);

	// The body being an argument is the mistake this command exists to prevent,
	// so it is named as such rather than reported as a stray word.
	const positional = run(["append-log.dive", "did the thing"], bridge, "body\n");
	assert.notEqual(positional.status, 0);
	assert.match(positional.stderr, /takes the section body on stdin, not as an argument/);

	const multiline = run(["append-log.dive", "--gist", "one\ntwo"], bridge, "body\n");
	assert.notEqual(multiline.status, 0);
	assert.match(multiline.stderr, /--gist must be a single line/);

	const noDive = run(["append-log.dive"], setup("no-active", { active: false }).bridge, "body\n");
	assert.notEqual(noDive.status, 0);
	assert.match(noDive.stderr, /no active dive to log against/);
});

test("append-log.dive refuses a marker pointing at a closed dive", () => {
	// `land` converts a dive to `kind: memo`; appending to one would edit history.
	const { bridge, divePath } = setup("closed", { kind: "memo" });
	const before = readFileSync(divePath, "utf8");

	const logged = run(["append-log.dive"], bridge, "body\n");
	assert.notEqual(logged.status, 0);
	assert.match(logged.stderr, /is not a kind: dive doc; it is kind: memo/);
	assert.equal(readFileSync(divePath, "utf8"), before, "a refusal must write nothing");
});

test("append-log.dive strips carriage returns out of a piped body", () => {
	const { bridge, divePath } = setup("crlf");

	assertOk(run(["append-log.dive"], bridge, "one\r\ntwo\r\n"), "append-log.dive failed");
	const doc = readFileSync(divePath, "utf8");
	assert.doesNotMatch(doc, /\r/, "CRLF would litter every later diff of this document");
	assert.match(doc, /^one\ntwo$/m);
});

/**
 * A section is progress when its heading carries a stamp, wherever the stamp
 * sits -- so every shape on this bridge reads as one, the hand-written one
 * included, and `## Brief` and `## Outcome` read as neither by carrying none.
 *
 * Each shape is asserted twice: through `never-jumped`, which is what `hasLog`
 * decides and therefore where the rule is actually consulted, and against the
 * decomposer directly, because what a heading decomposes *into* reaches no
 * command's output and a mangled label would otherwise go unnoticed.
 */
for (const [name, heading, logged, expectedLabel] of [
	// Every dive jumped before `jump` took a label carries this shape, so it
	// reading as progress is what makes that change need no migration.
	[
		"a bare stamp, as jump wrote before it took a label",
		"## 2026-08-17T14:25:57.907Z",
		true,
		undefined,
	],
	[
		"a labelled stamp, as jump, land and test write",
		"## Test report 2026-08-17T14:31:23.931Z",
		true,
		"Test report",
	],
	["a hand-written date with the label after", "## 2026-08-17 -- built", true, "built"],
	["a stamp carrying a UTC offset instead of Z", "## 2026-08-17T14:25:57+01:00", true, undefined],
	[
		"a negative offset, whose sign a label trim must not eat",
		"## built 2026-08-17T14:25:57-05:00",
		true,
		"built",
	],
	["a stamp with no zone at all", "## 2026-08-17T14:25:57", true, undefined],
	["a section that carries no stamp at all", "## Outcome", false, undefined],
	[
		"a stamp at a heading level that is not a section",
		"# 2026-08-17T14:25:57.907Z",
		false,
		undefined,
	],
]) {
	test(`${heading.split(" ")[0]} heading: ${name}`, () => {
		const slug = name.replaceAll(/[^a-z]+/g, "-");
		const { bridge, divePath } = setup(`shape-${slug}`);
		writeFileSync(divePath, `${readFileSync(divePath, "utf8")}\n${heading}\n\nBody.\n`);

		const listed = run(["list-dives", "--json"], bridge);
		assertOk(listed, "list-dives failed");
		// The report groups dives by rel, so the dive is looked up across groups.
		const dive = Object.values(JSON.parse(listed.stdout))
			.filter(Array.isArray)
			.flat()
			.find((entry) => entry.id === diveId);
		assert.ok(dive, `the dive should be listed:\n${listed.stdout}`);
		assert.equal(
			!dive.tags.includes("never-jumped"),
			logged,
			`${heading} should ${logged ? "" : "not "}count as a progress section`,
		);

		// What it decomposes *into* reaches no command's output, so the label is
		// asserted here or nowhere. A stamp shape the locator only half-matches
		// still counts as progress while spilling its own tail into the label,
		// which is the failure this half catches and the tags half cannot.
		const decomposed = decomposeSectionHeading(heading);
		assert.equal(decomposed !== undefined, logged);
		if (logged) {
			assert.ok(
				heading.endsWith(decomposed.stamp) || heading.startsWith(`## ${decomposed.stamp}`),
				`the stamp must be matched whole, got ${JSON.stringify(decomposed)} from ${heading}`,
			);
			assert.equal(decomposed.label, expectedLabel);
		}
	});
}
