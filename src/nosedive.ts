import { createRequire } from "node:module";
import {
	createCapturingIo,
	createConsoleIo,
	nosediveInvocationFor,
	readNosediveRc,
	type CommandIo,
} from "./lib/commands.js";
import {
	isContractedCommand,
	maybeRunContractCommand,
	parseCommandToken,
	printCommandHelp,
	renderTopLevelHelpText,
} from "./contracts.js";
export { collectDiveGates, collectFeatGates, collectReachableGates } from "./lib/landGates.js";
export { describeInstructionDrift, renderedSurfaceDigest } from "./lib/packageBacklog.js";
// The one reader of a section heading. Exported so the shapes it accepts can be
// asserted directly -- what a heading decomposes *into* reaches no command's
// output, so nothing else could tell a mangled label from a good one.
export { decomposeSectionHeading, hasLoggedSection } from "./lib/kbSections.js";
// Exported for the gate runner, which imports this entry by absolute path to
// build `ctx.resolve`. It is public surface because a spawned child has no
// other way in, not because callers outside nosedive are expected to use it.
export { createGateResolver } from "./lib/gateResolve.js";
// Exported so tests can exercise the id assertion directly: it alone keeps
// filename-is-the-id honest, and going through `seed` would obscure that fact.
export { readKbDocById } from "./lib/kbDocs.js";
export { createCapturingIo, createConsoleIo, nosediveInvocationFor, readNosediveRc };
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
	const [rawCommand, ...args] = argv;
	const parsedCommand = parseCommandToken(rawCommand);
	const command = parsedCommand?.name;

	const io = createConsoleIo();
	try {
		if (parsedCommand && (await maybeRunContractCommand(parsedCommand, args))) return;
		await runCoreCli(command, args, io);
	} finally {
		io.close();
	}
}

async function runCoreCli(
	command: string | undefined,
	args: string[],
	io: CommandIo,
): Promise<void> {
	const helpOnly = args.length === 1 && (args[0] === "-h" || args[0] === "--help");
	if (command !== undefined && helpOnly && isContractedCommand(command)) {
		printCommandHelp(command, io);
		return;
	}

	switch (command) {
		case "version":
		case "--version":
		case "-v":
			io.log(version);
			break;
		case undefined:
		case "help":
		case "--help":
		case "-h":
			io.log(renderTopLevelHelpText());
			break;
		default:
			io.err(`Unknown command: ${command}\n\n${renderTopLevelHelpText()}`);
			process.exit(1);
	}
}
