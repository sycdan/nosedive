import { captureCommand } from "./commandAdapter.js";
import { hydrateRepoWorkspace } from "./i54a65359b66f5194b66e4cad39f73de1.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { expectedWorktreePath } from "../lib/repoWorktrees.js";
import { resolveRepoDoc } from "../lib/repoWorkspaceCore.js";

function scan(args: string[], io: CommandIo): void {
	let repoRef: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--repo") {
			const value = args[index + 1];
			if (!value || value.startsWith("--")) throw new Error("scan --repo requires a value");
			if (repoRef) throw new Error("scan requires exactly one --repo <ref>");
			repoRef = value;
			index += 1;
			continue;
		}
		if (arg.startsWith("--repo=")) {
			const value = arg.slice("--repo=".length);
			if (!value) throw new Error("scan --repo requires a value");
			if (repoRef) throw new Error("scan requires exactly one --repo <ref>");
			repoRef = value;
			continue;
		}
		if (arg === "--deep") throw new Error("scan --deep is not implemented; use scan --repo <ref>");
		if (arg.startsWith("--")) throw new Error(`unknown scan option: ${arg}`);
		throw new Error(`unexpected scan argument: ${arg}; use --repo <ref>`);
	}
	if (!repoRef) throw new Error("scan requires exactly one --repo <ref>");

	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");
	const repoDoc = resolveRepoDoc(loadKbDocs(rc.kbDir, rc.bridgeDir), repoRef);

	// Reuse the command's managed-cache and ownership protections before briefing.
	hydrateRepoWorkspace([repoRef], io);
	const checkout = expectedWorktreePath(repoDoc, rc.bridgeDir);
	io.log("");
	io.log(`Inspect documentation only for repo ${repoDoc.id} (${repoDoc.name}).`);
	io.log(`Repo doc: ${formatPath(repoDoc.path)}`);
	io.log(`Checkout: ${formatPath(checkout)}`);
	io.log("");
	io.log(
		"Read README files, contributing guides, docs/, hooks, and CI configuration. Do not inspect source code.",
	);
	io.log(
		"Update the existing kind: repo doc with sourced facts about quality gates and local conventions. Preserve unrelated repo-doc content and avoid guesses.",
	);
	io.log(
		"For every documented runnable workload, create and link one meaningfully named kind: load doc. In each load body, record how to run it and cite the repository documentation as the source.",
	);
	io.log(
		"On a rescan, update the matching documented workload's existing kind: load doc in place. Preserve its id, inbound links, unrelated hand edits, and refresh only scan-owned facts. Create a new load doc only when no matching workload doc exists.",
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(scan, args);
}
