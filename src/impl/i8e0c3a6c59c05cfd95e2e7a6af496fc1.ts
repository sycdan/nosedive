import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import { HELM_PROTOCOL } from "../lib/coreProtocol.js";
import { packageRoot } from "../lib/packageBacklog.js";

const HELM_BIN = "nosedive-helm";

/** The helm to run: NOSEDIVE_HELM when set, else nosedive-helm on PATH, else none. */
function findHelm(): string | undefined {
	const given = process.env.NOSEDIVE_HELM;
	if (given) return given;
	const exts =
		process.platform === "win32" ? (process.env.PATHEXT ?? ".CMD;.EXE").split(";") : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean))
		for (const ext of exts) {
			const candidate = join(dir, HELM_BIN + ext.toLowerCase());
			if (existsSync(candidate)) return candidate;
		}
	return undefined;
}

/** Spawns a helm, a script through this node, a Windows shim through its shell. */
function spawnHelm(helm: string, args: string[], env: NodeJS.ProcessEnv) {
	const ext = extname(helm).toLowerCase();
	if ([".js", ".mjs", ".cjs"].includes(ext))
		return spawn(process.execPath, [helm, ...args], { stdio: "inherit", env });
	const shim = process.platform === "win32" && [".cmd", ".bat"].includes(ext);
	return spawn(shim ? `"${helm}"` : helm, args, { stdio: "inherit", env, shell: shim });
}

/**
 * `nosedive helm` runs nosedive-helm, a separate product, against this core:
 * NOSEDIVE_CORE is this package's root, whose `dist/nosedive.js` helm imports,
 * NOSEDIVE_CLI the cli helm runs for every write, and NOSEDIVE_PROTOCOL the
 * version of the core API it may rely on.
 */
export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(async (commandArgs, io) => {
		const helm = findHelm();
		if (!helm) {
			io.err(
				"helm is not installed: it is a separate product, run through `nosedive helm` once it is.",
			);
			io.setExitCode(1);
			return;
		}
		const root = packageRoot();
		const env = {
			...process.env,
			NOSEDIVE_CORE: root,
			NOSEDIVE_CLI: join(root, "dist", "cli.js"),
			NOSEDIVE_PROTOCOL: String(HELM_PROTOCOL),
		};
		const code = await new Promise<number>((resolveCode) => {
			const child = spawnHelm(helm, commandArgs, env);
			child.on("error", (err) => {
				io.err(`helm did not start: ${helm}: ${err.message}`);
				resolveCode(1);
			});
			child.on("exit", (exit) => resolveCode(exit ?? 1));
		});
		io.setExitCode(code);
	}, args);
}
