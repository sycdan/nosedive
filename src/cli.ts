#!/usr/bin/env node
import { runCli } from "./nosedive.js";
import { renderPackageKbGist } from "./lib/gitState.js";
import { nosediveInvocation } from "./lib/packageBacklog.js";
import { uuidLike } from "./lib/repoWorkspaceCore.js";

runCli().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	if (uuidLike(message)) {
		try {
			console.error(`nosedive-error: ${renderPackageKbGist(message)}`);
			console.error(`more info: ${nosediveInvocation()} render ${message}`);
		} catch {
			console.error(`nosedive: ${message}`);
		}
	} else {
		console.error(`nosedive: ${message}`);
	}
	process.exit(1);
});
