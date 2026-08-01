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
import { baseConfigPath, formatPath } from "../lib/coreParsing.js";
import {
	printCommandHelp,
	promptAgents,
	writeNosediveDirGitignore,
} from "../lib/packageBacklog.js";
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";

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

	const basePath = baseConfigPath(bridgeDir);
	writeFileAtomic(basePath, renderBaseConfig(settings, CURRENT_COMPATIBILITY_LEVEL));
	writeNosediveDirGitignore(bridgeDir);
	io.log(`Wrote ${formatPath(basePath)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(seed, args);
}
