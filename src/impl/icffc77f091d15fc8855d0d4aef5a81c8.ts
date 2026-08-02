import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import {
	CommandIo,
	loadSplitRcSettings,
	migrateBridgeConfig,
	parseSeedOptions,
	promptScalar,
	renderBaseConfig,
} from "../lib/bridgeSetupIo.js";
import { CURRENT_COMPATIBILITY_LEVEL } from "../lib/constants.js";
import { baseConfigPath, formatPath, resolveFrom } from "../lib/coreParsing.js";
import {
	printCommandHelp,
	promptAgents,
	writeNosediveDirGitignore,
} from "../lib/packageBacklog.js";
import { gitOutput, quoteYamlString, writeFileAtomic } from "../lib/renderPlan.js";
import { uuidLike } from "../lib/repoWorkspaceCore.js";
import { uuid7AtMs } from "../lib/uuid7.js";

function mintBacklogMemo(bridgeDir: string, kbDir: string, io: CommandIo): string {
	const id = uuid7AtMs(Date.now());
	const name = basename(bridgeDir);
	const path = join(kbDir, `${id}.md`);
	mkdirSync(kbDir, { recursive: true });
	writeFileAtomic(
		path,
		[
			"---",
			"kind: memo",
			`id: ${id}`,
			`name: backlog.${name}`,
			`gist: ${quoteYamlString(`Current backlog for ${name}.`)}`,
			"---",
			"",
			"# Backlog",
			"",
			"## Current efforts",
			"",
		].join("\n"),
	);
	io.log(`Wrote ${formatPath(path)}`);
	return id;
}

async function seed(args: string[], io: CommandIo): Promise<void> {
	const options = parseSeedOptions(args);
	if (options.help) {
		printCommandHelp("seed", io);
		return;
	}

	const bridgeDir = process.cwd();
	if (!gitOutput(bridgeDir, ["rev-parse", "--show-toplevel"])) {
		throw new Error("nosedive seed must be run inside a git repository");
	}

	await migrateBridgeConfig(bridgeDir, io);

	const settings = loadSplitRcSettings(bridgeDir);

	if (!options.headless) {
		try {
			settings.workspace = await promptScalar(io, "workspace", settings.workspace);
			settings.backlog = await promptScalar(io, "backlog", settings.backlog);
			settings.kb = await promptScalar(io, "kb", settings.kb);
			settings.homeBranch = await promptScalar(io, "home-branch", settings.homeBranch);
			settings.workBranchPrefix = await promptScalar(
				io,
				"work-branch-prefix",
				settings.workBranchPrefix,
			);
			settings.agents = await promptAgents(io, settings.agents);
		} finally {
			io.close();
		}
	}

	// At L1 `backlog:` names a kb memo, not a directory. A bridge migrated from
	// L0 already carries the memo its migration minted; a fresh one does not,
	// and without this update-backlog and dump-backlog have nothing to read.
	if (!uuidLike(settings.backlog)) {
		settings.backlog = mintBacklogMemo(bridgeDir, resolveFrom(bridgeDir, settings.kb), io);
	}

	const basePath = baseConfigPath(bridgeDir);
	writeFileAtomic(basePath, renderBaseConfig(settings, CURRENT_COMPATIBILITY_LEVEL));
	writeNosediveDirGitignore(bridgeDir);
	io.log(`Wrote ${formatPath(basePath)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(seed, args);
}
