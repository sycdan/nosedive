import { spawnSync } from "node:child_process";

function gitConfig(cwd, key) {
	const result = spawnSync("git", ["config", key], { cwd, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

export async function run(value, ctx) {
	const name = gitConfig(ctx.cwd, "user.name");
	const email = gitConfig(ctx.cwd, "user.email");
	const missing = [];
	if (!name) missing.push("user.name");
	if (!email) missing.push("user.email");

	if (missing.length > 0) {
		return {
			output: `missing git config: ${missing.join(", ")}\n`,
			exitCode: 1,
		};
	}

	return {
		output: `nosedive-pilot-name: ${name}\nnosedive-pilot-email: ${email}\n`,
		exitCode: 0,
	};
}
