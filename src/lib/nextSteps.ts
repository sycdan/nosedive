import { CommandIo } from "./bridgeSetupIo.js";

/**
 * Print the commands a pilot can run next under one header, after a blank line.
 * A bare command trailing a run of `Wrote <path>` or `reset repo=` lines reads as
 * more of the same rather than as a choice, so every site that suggests a next
 * step frames it the same way.
 */
export function printNextSteps(io: CommandIo, commands: string[]): void {
	io.log("");
	io.log("Next steps:");
	for (const command of commands) io.log(command);
}
