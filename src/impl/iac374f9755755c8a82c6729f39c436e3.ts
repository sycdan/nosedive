import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo, loadGitPilotIdentity } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import {
	parseWhoamiOptions,
	printCommandHelp,
	resolveIdentityField,
} from "../lib/packageBacklog.js";

function whoami(args: string[], io: CommandIo): void {
	const options = parseWhoamiOptions(args);
	if (options.help) {
		printCommandHelp("whoami", io);
		return;
	}

	const rc = readNosediveRc(process.cwd());
	const detected = loadGitPilotIdentity(rc.bridgeDir);
	const fields = [
		resolveIdentityField("pilot-name", rc.pilotName, detected.pilotName),
		resolveIdentityField("pilot-email", rc.pilotEmail, detected.pilotEmail),
	];

	for (const field of fields) io.log(`${field.key}: ${field.value}`);
	for (const field of fields) {
		if (field.source === "git") {
			io.err(`notice: ${field.key} inferred from git config; run \`nosedive seed\` to persist it`);
		}
		if (field.source === "unset") {
			io.err(
				`notice: ${field.key} is not configured in bridge config or git config; run \`nosedive seed\` to persist it`,
			);
		}
	}

	if (fields.some((field) => field.source === "unset")) io.setExitCode(1);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(whoami, args);
}
