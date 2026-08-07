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
		const parent = kbDocs.find((doc) => doc.kind === "feat" && doc.id === parentRef);
		if (!parent) throw new Error(`effort ${current.id} links missing parent effort ${parentRef}`);
		if (seen.has(parent.id)) throw new Error(`effort ancestry contains a cycle at ${parent.id}`);
		seen.add(parent.id);
		efforts.push(parent);
		current = parent;
	}
}

function spin(args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	// Checked before the words, so a pilot with no dive is told the thing that
	// blocks them rather than a usage error they would still hit afterwards.
	if (!readActiveDiveId(rc.workspaceDir))
		throw new Error(
			"no active dive: spin needs an effort from the dive named in workspace/.nosedive-ref",
		);

	const words = args.join(" ").trim();
	if (!words) throw new Error("spin requires words describing the loads to select");

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
	// A repo with no loads has not necessarily gone unscanned: a library or a
	// CLI has nothing runnable to record, and saying otherwise would assert a
	// falsehood on every spin for the rest of that repo's life.
	const loadless = new Map<string, KbDoc>();
	for (const repo of repos.values()) {
		const repoLoads = repo.links
			.map((link) => kbDocs.find((doc) => doc.id === link.id))
			.filter((doc): doc is KbDoc => doc?.kind === "load");
		if (repoLoads.length === 0) loadless.set(repo.id, repo);
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
	if (loadless.size > 0) {
		io.log("");
		io.log("== repos without loads ==");
		for (const repo of loadless.values())
			io.log(
				`- ${repo.name} documents no loads; if it runs services, scan --repo ${repo.id} to record them`,
			);
	}
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(spin, args);
}
