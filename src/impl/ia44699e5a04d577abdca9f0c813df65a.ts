import { pilotIdentityLines, readPilotIdentity } from "../lib/gitState.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";

export function run(_args: string[], runtime: ImplRuntime): ImplCommandOutput {
	const identity = readPilotIdentity(runtime.cwd);

	if (identity.missing.length > 0) {
		return {
			stdout: "",
			stderr: `missing git config: ${identity.missing.join(", ")}\n`,
			exitCode: 1,
		};
	}

	return {
		stdout: pilotIdentityLines(identity),
		stderr: "",
		exitCode: 0,
	};
}
