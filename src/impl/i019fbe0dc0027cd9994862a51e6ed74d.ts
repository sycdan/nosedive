import { mintUuid7Lines } from "../lib/uuid7.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";

export function run(args: string[], _runtime?: ImplRuntime): ImplCommandOutput {
	return {
		stdout: mintUuid7Lines(args)
			.map((line) => `${line}\n`)
			.join(""),
		stderr: "",
		exitCode: 0,
	};
}
