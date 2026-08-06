import { existsSync } from "node:fs";

import { captureCommand } from "./commandAdapter.js";
import { hydrateRepoWorkspace } from "./i54a65359b66f5194b66e4cad39f73de1.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { nosediveInvocation } from "../lib/packageBacklog.js";
import { expectedWorktreePath, isDirEmpty } from "../lib/repoWorktrees.js";
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

	// However this build was reached is how the agent should reach it too.
	const cli = nosediveInvocation();
	const checkout = expectedWorktreePath(repoDoc, rc.bridgeDir);
	// Only when the checkout is missing. Hydrating an existing one detaches it at
	// the repo's trunk, which would move a repo the active dive has pinned
	// elsewhere -- scanning is a read, and must not disturb work in progress.
	if (!existsSync(checkout) || isDirEmpty(checkout)) {
		hydrateRepoWorkspace([repoRef], io);
	}
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
		"For every documented runnable workload, create and link one kind: load doc: mint an id with " +
			`\`${cli} mint\`, write it as ${formatPath(rc.kbDir)}/<uuid>.md, and link it from the repo doc.`,
	);
	io.log(
		"Name each load for what a pilot would type, not for this repo: `<app>-backend.<repo-slug>`, one per runnable thing, since that name is what spin matches against.",
	);
	io.log(
		"In each load body, record how to run it and cite the repository documentation as the source.",
	);
	io.log(
		"On a rescan, update the matching documented workload's existing kind: load doc in place. Preserve its id, inbound links, unrelated hand edits, and refresh only scan-owned facts. Create a new load doc only when no matching workload doc exists.",
	);
	io.log(
		"Check the loads already linked from the repo doc in both directions: a load the current docs no longer describe has probably been removed from the repo. Say so in the scan output and note it in that load's body. Never delete a load doc -- an inbound link may name it, and retiring one is the pilot's call.",
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(scan, args);
}
