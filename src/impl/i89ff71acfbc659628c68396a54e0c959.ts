import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { KbDoc, loadKbDocs, readActiveDiveId } from "../lib/kbDocs.js";
import { resolveActiveEffortDoc } from "../lib/repoEffortScopes.js";

function effortAncestry(effort: KbDoc, kbDocs: KbDoc[]): KbDoc[] {
	const efforts = [effort];
	const seen = new Set([effort.id]);
	let current = effort;
	for (;;) {
		const parentRef = current.links.find((link) => link.rel === "parent")?.id;
		if (!parentRef) return efforts;
		const parent = kbDocs.find((doc) => doc.kind === "effort" && doc.id === parentRef);
		if (!parent) throw new Error(`effort ${current.id} links missing parent effort ${parentRef}`);
		if (seen.has(parent.id)) throw new Error(`effort ancestry contains a cycle at ${parent.id}`);
		seen.add(parent.id);
		efforts.push(parent);
		current = parent;
	}
}

function spin(args: string[], io: CommandIo): void {
	const words = args.join(" ").trim();
	if (!words) throw new Error("spin requires words describing the loads to select");

	const rc = readNosediveRc(process.cwd());
	if (!readActiveDiveId(rc.workspaceDir))
		throw new Error(
			"no active dive: spin needs an effort from the dive named in workspace/.nosedive-ref",
		);
	if (!rc.kbDir) throw new Error("spin requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const effort = resolveActiveEffortDoc(kbDocs, rc);
	const repos = new Map<string, KbDoc>();
	for (const ancestor of effortAncestry(effort, kbDocs)) {
		for (const scope of ancestor.scopes) {
			const repo = kbDocs.find((doc) => doc.kind === "repo" && doc.id === scope.repoId);
			if (!repo) throw new Error(`effort ${ancestor.id} scopes missing repo ${scope.repoId}`);
			repos.set(repo.id, repo);
		}
	}

	const loads = new Map<string, KbDoc>();
	const unscanned = new Map<string, KbDoc>();
	for (const repo of repos.values()) {
		const repoLoads = repo.links
			.map((link) => kbDocs.find((doc) => doc.id === link.id))
			.filter((doc): doc is KbDoc => doc?.kind === "load");
		if (repoLoads.length === 0) unscanned.set(repo.id, repo);
		for (const load of repoLoads) loads.set(load.id, load);
	}

	io.log("== spin brief ==");
	io.log(`Pilot words: ${words}`);
	io.log("");
	io.log("Choose the loads that best match the pilot's words. Do not start anything yet.");
	io.log("");
	io.log("== load candidates ==");
	if (loads.size === 0) io.log("(none)");
	for (const load of loads.values()) io.log(`- ${load.name}: ${load.gist}`);
	if (unscanned.size > 0) {
		io.log("");
		io.log("== repos without loads ==");
		for (const repo of unscanned.values())
			io.log(`- ${repo.name} has not been scanned; run scan --repo ${repo.id}`);
	}
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(spin, args);
}
