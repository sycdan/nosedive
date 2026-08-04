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
	escapeRegExp,
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

const { readNosediveRc } = await import(libUrl);
const tmp = createTmp("contract-help");
const noBridge = createNoBridge(tmp);

test("contract help", () => {
	const whoamiContractBridge = createBridge(tmp, "contract-help-bridge", { backlog: "./backlog" });

	// L0 is gone: every command the package ships is contracted at L1.
	const contractedCommands = [
		["add-repo.effort", /Usage: nosedive add-repo\.effort <repo-id-or-name>/],
		["dehydrate-repo.workspace", /Usage: nosedive dehydrate-repo\.workspace/],
		["dump-backlog", /Usage: nosedive dump-backlog$/m],
		["hydrate-repo.workspace", /Usage: nosedive hydrate-repo\.workspace/],
		["list-dives", /Usage: nosedive list-dives <effort>/],
		["mint", /Usage: nosedive mint \[count\] \[--ms <utcmillis>\] \[--ts <iso8601>\]/],
		["nuke", /Usage: nosedive nuke --config\|--workspace/],
		["pitch", /Usage: nosedive pitch "<gist>"/],
		["_pre-push.hook", /Usage: nosedive _pre-push\.hook/],
		["preflight", /Usage: nosedive preflight/],
		["prove", /Usage: nosedive prove <assertion-ref>/],
		["render", /Usage: nosedive render <uuid>/],
		["record.dive", /Usage: nosedive record\.dive \[--ref <dive-ref>\]/],
		["seed", /Usage: nosedive seed \[--file <path>\]\.\.\. \[--headless\]/],
		["update-backlog", /Usage: nosedive update-backlog/],
		["whoami", /Usage: nosedive whoami/],
	].map(([command, usage]) => [command, usage, 1]);

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
	const contractHelpLinks = {
		preflight: [
			/\[`_pre-push\.hook`\]\(9e3a676a-6d2f-5b93-93af-f4608ed28843\.md\)/,
			/\[`seed`\]\(34c8e9fb-9629-5767-9a81-914f78c63b68\.md\)/,
		],
		seed: [/\]\(a40303c1-1362-523f-b095-49178354f878\.md\)/],
	};
	for (const [command, usage, level] of contractedCommands) {
		const explicitHelp = run([`${command}@${level}`, "--help"], whoamiContractBridge);
		assertOk(explicitHelp, `${command}@${level} --help failed`);
		assert.match(explicitHelp.stdout, usage, `${command}@${level} --help missing usage line`);
		for (const expectedLink of contractHelpLinks[command] ?? []) {
			assert.match(
				explicitHelp.stdout,
				expectedLink,
				`${command}@${level} --help missing kb doc link`,
			);
		}
		const openingFence = explicitHelp.stdout.slice(0, explicitHelp.stdout.indexOf("\n"));
		assert.match(
			openingFence,
			/^`{3,}md$/,
			`${command}@${level} --help should start with a markdown fence`,
		);
		const closingFence = openingFence.slice(0, -"md".length);
		assert.match(
			explicitHelp.stdout,
			new RegExp(`^${escapeRegExp(openingFence)}\\n\\n?# `),
			`${command}@${level} --help should fence the command body`,
		);
		assert.match(
			explicitHelp.stdout,
			new RegExp(`\\n${escapeRegExp(closingFence)}\\n\\nUsage: nosedive`),
			`${command}@${level} --help should close the markdown fence before usage`,
		);
		assert.ok(
			explicitHelp.stdout.indexOf("Usage: nosedive") > explicitHelp.stdout.indexOf("# "),
			`${command}@${level} --help should print usage after body`,
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
