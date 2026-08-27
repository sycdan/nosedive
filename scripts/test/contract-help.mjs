import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
	assertContainsPath,
	assertGeneratedFrontmatter,
	assertOk,
	cli,
	createNoBridge,
	createBridge,
	createTmp,
	gitCommit,
	gitCommonDir,
	handoffRunbookId,
	lib,
	libUrl,
	packageFoundationDocs,
	packageMigrationDoc,
	packageMigrationScript,
	packageNonFoundationDoc,
	root,
	run,
	runGit,
	runGitUnchecked,
	runTool,
	write,
	writeBridgeConfig,
} from "../test-helpers.mjs";

const { nosediveInvocationFor, readNosediveRc } = await import(libUrl);
const tmp = createTmp("contract-help");
const noBridge = createNoBridge(tmp);

test("contract help", () => {
	const whoamiContractBridge = createBridge(tmp, "contract-help-bridge", { backlog: "./backlog" });
	const readme = readFileSync(join(root, "README.md"), "utf8");

	/**
	 * The builtin route serves a command's latest level, so the explicit route
	 * has to be asked for that same level or the two legitimately differ. Read
	 * it from the package rather than pinning a number here, which is what made
	 * this test fail the first time a command was republished at @2.
	 */
	const latestLevels = new Map();
	const latestFiles = new Map();
	const latestDeprecated = new Map();
	const latestTitles = new Map();
	for (const docName of readdirSync(join(root, "kb")).filter((name) => name.endsWith(".md"))) {
		const docText = readFileSync(join(root, "kb", docName), "utf8");
		if (!/^kind: command$/m.test(docText)) continue;
		const named = /^name: (.+)@(\d+)$/m.exec(docText);
		if (!named) continue;
		const level = Number(named[2]);
		if (level > (latestLevels.get(named[1]) ?? -1)) {
			latestLevels.set(named[1], level);
			latestFiles.set(named[1], docName);
			latestDeprecated.set(named[1], /^  use-instead:/m.test(docText));
			latestTitles.set(named[1], /^#\s+(.+?)\s*$/m.exec(docText)?.[1]);
		}
	}

	// L0 is gone: every command the package ships is contracted at L1 or above.
	const contractedCommands = [
		["add-repo.effort", /Usage: nosedive add-repo\.effort <repo-id-or-name>/],
		["add-repo.feat", /Usage: nosedive add-repo\.feat <repo-id-or-name>/],
		["dehydrate-repo.workspace", /Usage: nosedive dehydrate-repo\.workspace/],
		["dump-backlog", /Usage: nosedive dump-backlog$/m],
		["hydrate-repo.workspace", /Usage: nosedive hydrate-repo\.workspace/],
		["mint", /Usage: nosedive mint \[count\] \[--ms <utcmillis>\] \[--ts <iso8601>\]/],
		["nuke", /Usage: nosedive nuke --config\|--workspace/],
		["pitch", /Usage: nosedive pitch "<gist>"/],
		["plan", /Usage: nosedive plan \[<context>\]/],
		["_pre-push.hook", /Usage: nosedive _pre-push\.hook/],
		["preflight", /Usage: nosedive preflight/],
		["prove", /Usage: nosedive prove <assertion-ref>/],
		["render", /Usage: nosedive render <uuid>/],
		["record.dive", /Usage: nosedive record\.dive \[<dive>\]/],
		["record.feat", /Usage: nosedive record\.feat \[<feat>\]/],
		["seed", /Usage: nosedive seed \[--file <path>\]\.\.\. \[--headless\]/],
		["update-backlog", /Usage: nosedive update-backlog/],
		["whoami", /Usage: nosedive whoami/],
	].map(([command, usage]) => [command, usage, latestLevels.get(command) ?? 1]);

	for (const docName of readdirSync(join(root, "kb")).filter((name) => name.endsWith(".md"))) {
		const docText = readFileSync(join(root, "kb", docName), "utf8");
		if (!/^kind: command$/m.test(docText)) continue;
		assert.doesNotMatch(docText, /^name: \S+@0$/m, `${docName} is still contracted at L0`);
		assert.doesNotMatch(
			docText,
			/^  usage: Usage:/m,
			`${docName} meta.usage should not include the rendered Usage: prefix`,
		);
		assert.match(
			docText,
			/^  usage: nosedive /m,
			`${docName} meta.usage should start with the bare command shape`,
		);
		assert.doesNotMatch(
			docText,
			/^  usage: \|-/m,
			`${docName} meta.usage should be a one-line scalar`,
		);
	}
	const listDivesHelp = run(["list-dives", "--help"], noBridge);
	assertOk(listDivesHelp, "list-dives --help failed");
	assert.match(listDivesHelp.stdout, /Usage: nosedive list-dives \[<feat-or-deck>\]/);
	assert.match(
		listDivesHelp.stdout,
		/\[read the manual\]\(kb\/116ff634-3742-51ba-977f-44fc5b21e9e4\.md\)\./,
	);
	write(
		join(whoamiContractBridge, "kb", "019f8584-453f-79ea-9d53-5f1b20b4cda9.md"),
		`---
kind: feat
id: 019f8584-453f-79ea-9d53-5f1b20b4cda9
name: deprecated-list-dives
gist: "Legacy command fixture."
---
`,
	);
	const featScopedListDives = run(
		["list-dives", "019f8584-453f-79ea-9d53-5f1b20b4cda9"],
		whoamiContractBridge,
	);
	assertOk(featScopedListDives, "list-dives failed");
	assert.match(featScopedListDives.stdout, /^Scope: feat deprecated-list-dives$/m);
	for (const [command, usage, level] of contractedCommands) {
		const explicitHelp = run([`${command}@${level}`, "--help"], whoamiContractBridge);
		assertOk(explicitHelp, `${command}@${level} --help failed`);
		assert.match(explicitHelp.stdout, usage, `${command}@${level} --help missing usage line`);
		assert.equal(
			explicitHelp.stdout.trim().split("\n").length,
			5,
			`${command}@${level} --help should contain only usage, gist, and the manual link`,
		);
		const usageTail = explicitHelp.stdout.slice(explicitHelp.stdout.indexOf("Usage: nosedive"));
		assert.match(
			usageTail,
			/^Usage: nosedive[^\n]*\n\n\S/m,
			`${command}@${level} --help should print bare gist after usage`,
		);
		assert.doesNotMatch(
			usageTail,
			/^[ \t]{2,}\S/m,
			`${command}@${level} --help usage section should not contain extra indented prose`,
		);
		assert.doesNotMatch(
			usageTail,
			/\ngist:/i,
			`${command}@${level} --help should not prefix the gist`,
		);
		assert.doesNotMatch(
			explicitHelp.stdout,
			/^---$/m,
			`${command}@${level} --help leaked frontmatter delimiters`,
		);
		assert.ok(latestFiles.has(command), `${command} has no latest command doc filename`);
		assert.ok(
			explicitHelp.stdout.includes(`[read the manual](kb/${latestFiles.get(command)}).`),
			`${command}@${level} --help is missing its command doc link`,
		);
		if (!command.startsWith("_") && !latestDeprecated.get(command)) {
			const npmInvocation = nosediveInvocationFor(false, root);
			assert.ok(
				readme.includes(
					[
						`#### [${latestTitles.get(command)}](kb/${latestFiles.get(command)})`,
						"",
						"##### Usage",
						"",
						"```sh",
						`$ ${npmInvocation} ${command} --help`,
						explicitHelp.stdout.trim(),
						"```",
					].join("\n"),
				),
				`README section for ${command}@${level} differs from its doc title, invocation, or help`,
			);
		}

		// Same help text whether the command doc routed it or the builtin did.
		const builtinHelp = run([command, "--help"], noBridge);
		assertOk(builtinHelp, `${command} --help outside a bridge failed`);
		assert.equal(
			builtinHelp.stdout,
			explicitHelp.stdout,
			`${command} help differs between builtin and command routes`,
		);
	}
});

/**
 * Deprecation is a property of a command, not of one of its docs. A command
 * deprecated at its newest level still has older docs that predate the
 * deprecation, and listing the command under one of those advertises it in
 * wording chosen before we decided against it -- `add-repo.effort` was listed
 * under its L1 gist, which still called a feat an effort.
 */
test("the command list omits a command whose latest doc is deprecated", () => {
	const latest = new Map();
	for (const docName of readdirSync(join(root, "kb")).filter((name) => name.endsWith(".md"))) {
		const docText = readFileSync(join(root, "kb", docName), "utf8");
		if (!/^kind: command$/m.test(docText)) continue;
		const named = /^name: (.+)@(\d+)$/m.exec(docText);
		if (!named) continue;
		const [, command, rawLevel] = named;
		const level = Number(rawLevel);
		if (level < (latest.get(command)?.level ?? -1)) continue;
		latest.set(command, { level, deprecated: /^  use-instead:/m.test(docText) });
	}

	const listed = run(["help"], noBridge);
	assertOk(listed, "help failed");
	const commands = new Set(
		listed.stdout
			.split("\n")
			.map((line) => /^ {2}(\S+) {2,}\S/.exec(line)?.[1])
			.filter((command) => command !== undefined),
	);

	// Guards the loop below against passing because it found nothing to check.
	assert.ok(commands.has("add-repo.feat"), "help should list add-repo.feat");
	assert.ok(
		!commands.has("add-repo.effort"),
		"help should not list add-repo.effort: its latest doc is deprecated",
	);
	assert.ok(commands.has("record.feat"), "help should list record.feat");
	assert.ok(!commands.has("pitch"), "help should not list pitch: its latest doc is deprecated");

	for (const [command, { deprecated }] of latest) {
		if (command.startsWith("_")) continue;
		if (deprecated) {
			assert.ok(!commands.has(command), `help lists ${command}, whose latest doc is deprecated`);
		} else {
			assert.ok(commands.has(command), `help omits ${command}, which is not deprecated`);
		}
	}
});

/**
 * A deprecation only the surface renderers know about is one the pilot who
 * still types the old spelling never hears: the command keeps working and
 * never mentions its replacement. The notice goes to stderr because stdout is
 * parsed -- the quickstart reads the written doc's path out of it.
 */
test("a deprecated command names its replacement on stderr, and nothing else changes", () => {
	const bridge = createBridge(tmp, "contract-help-deprecation-bridge");

	const deprecated = run(["pitch", "Reached by the retired spelling."], bridge);
	assertOk(deprecated, "the deprecated pitch spelling failed");
	assert.match(
		deprecated.stderr,
		/^nosedive: warning: pitch is deprecated; use instead: .*record\.feat/m,
		"a deprecated command must name itself and its replacement on stderr",
	);
	assert.doesNotMatch(deprecated.stdout, /deprecated/i, "the notice must not reach stdout");

	// `--gist` rather than a positional: this is about a command being announced
	// dead, and a positional gist earns its own deprecation notice these days.
	const live = run(["record.feat", "--gist", "Reached by the live spelling."], bridge);
	assertOk(live, "record.feat failed");
	assert.doesNotMatch(live.stderr, /is deprecated/, "a live command must not be announced dead");

	// The notice is advice, not a verdict: it neither rescues a failing run nor
	// spoils a passing one.
	const refused = run(["pitch"], bridge, "");
	assert.notEqual(refused.status, 0, "pitch without a gist unexpectedly succeeded");
	assert.match(refused.stderr, /^nosedive: warning: pitch is deprecated; /m);
});
