import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { printCommandHelp } from "../lib/packageBacklog.js";

const LOG_HINT = "--log reads its body from stdin: echo <body> | nosedive dive --log[:<event>] -";
const DIVE_HINT = "dive needs a feat and a gist: echo <brief> | nosedive dive <feat> <gist...>";

/** Removes `<flag> <value>` from args, wherever it sits, and returns the value. */
function takeFlag(args: string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	if (at === -1) return undefined;
	const value = args[at + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
	args.splice(at, 2);
	return value;
}

/** Hands args to another command's impl; `contracts.ts` fills the registry before any command runs. */
function delegate(
	runtime: ImplRuntime,
	id: string,
	args: string[],
): ImplCommandOutput | Promise<ImplCommandOutput> {
	const impl = runtime.impl?.[id];
	if (!impl) throw new Error(`dive: ${id} is not in the impl registry`);
	return impl(args);
}

/**
 * The record family's dive commands under one name: `dive <feat> <gist...>`
 * is `record.dive` and `dive --log[:<event>] -` is `append-log.dive`. It only
 * translates arguments and hands over, stdin and all, so what it writes and
 * commits is theirs, exactly.
 */
async function dive(args: string[], runtime: ImplRuntime): Promise<ImplCommandOutput> {
	const log = args.findIndex((arg) => arg === "--log" || arg.startsWith("--log:"));
	if (log !== -1) {
		if (args[log + 1] !== "-") throw new Error(LOG_HINT);
		const rest = args.filter((_, i) => i !== log && i !== log + 1);
		if (rest.length > 0) throw new Error(`dive --log takes nothing else: ${rest.join(" ")}`);
		const event = args[log]!.slice("--log:".length);
		return delegate(runtime, "i00671103fb8b50d89ffc60e3eb0f4745", event ? ["--label", event] : []);
	}
	const title = takeFlag(args, "--title");
	const [feat, ...words] = args;
	const gist = words.join(" ").trim();
	if (!feat || feat.startsWith("--") || !gist) throw new Error(DIVE_HINT);
	return delegate(runtime, "idfa77573dddc590cb8f5f5ff784c3384", [
		"--feat",
		feat,
		"--gist",
		gist,
		...(title ? ["--title", title] : []),
		"--brief",
		"-",
	]);
}

export function run(args: string[], runtime: ImplRuntime): Promise<ImplCommandOutput> {
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help")
		return captureCommand((_, io) => {
			printCommandHelp("dive", io);
			if (args.length === 0) io.setExitCode(1);
		}, args);
	return dive([...args], runtime);
}
