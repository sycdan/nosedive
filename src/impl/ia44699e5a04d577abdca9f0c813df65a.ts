import { spawnSync } from "node:child_process";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";

function gitConfig(cwd: string, key: string): string {
	const result = spawnSync("git", ["config", key], { cwd, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

export function run(_args: string[], runtime: ImplRuntime): ImplCommandOutput {
	const name = gitConfig(runtime.cwd, "user.name");
	const email = gitConfig(runtime.cwd, "user.email");
	const missing: string[] = [];
	if (!name) missing.push("user.name");
	if (!email) missing.push("user.email");

	if (missing.length > 0) {
		return {
			stdout: "",
			stderr: `missing git config: ${missing.join(", ")}\n`,
			exitCode: 1,
		};
	}

	return {
		stdout: `nosedive-pilot-name: ${name}\nnosedive-pilot-email: ${email}\n`,
		stderr: "",
		exitCode: 0,
	};
}
