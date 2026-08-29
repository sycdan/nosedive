import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { formatPath, parseMarkdownDoc, type NosediveRc } from "./coreParsing.js";
import type { KbDoc } from "./kbDocs.js";
import type { DropRepo } from "./drop.js";
import type { LandGate } from "./landGates.js";

export function resolvePromptDoc(kbDocs: KbDoc[], rc: NosediveRc, command: string): KbDoc {
	const promptId = (rc.prompts[command] ?? "").trim();
	if (!promptId) throw new Error(`${formatPath(rc.path)} has no ${command}-prompt`);

	const doc = kbDocs.find((candidate) => candidate.id === promptId);
	if (!doc) throw new Error(`${command} prompt not found: ${promptId}`);
	if (doc.kind !== "idea") {
		throw new Error(`${command} prompt ${promptId} must be kind: idea, not ${doc.kind}`);
	}
	if (doc.name !== `${command}.prompt`) {
		throw new Error(
			`${command} prompt ${promptId} must be named ${command}.prompt, not ${doc.name}`,
		);
	}
	return doc;
}

export function readPromptBody(promptDoc: KbDoc): string {
	const label = formatPath(promptDoc.path);
	if (!existsSync(promptDoc.path)) throw new Error(`${label} is missing`);
	const body = parseMarkdownDoc(readFileSync(promptDoc.path, "utf8"), label).body.trim();
	if (!body) throw new Error(`${label} has an empty body, so there is no prompt to run`);
	return body;
}

/**
 * The idea doc says what to do and the context block says what to do it to, so
 * one prompt doc serves every drop. The block is generated rather than written
 * because a hand-copied quid or date is a prompt that quietly describes the
 * wrong release.
 */
export function renderDropPrompt(
	promptBody: string,
	context: {
		feat: KbDoc;
		today: string;
		repos: DropRepo[];
		gates: LandGate[];
		bridgeRepoNote?: string;
	},
): string {
	const { feat, today, repos, gates, bridgeRepoNote } = context;
	const repoLines = repos.flatMap((repo) => [
		`- ${repo.doc.name} -- ${repo.worktreePath}`,
		`    trunk: ${repo.trunk}`,
		`    merge: ${repo.merge}`,
		`    branch-convention: ${repo.branchConvention || "(none)"}`,
		`    work branch: ${repo.workBranch} -> ${repo.workBranchSha}`,
	]);
	const gateLines = gates.map(
		(gate) => `    nosedive test ${gate.doc.id}    # ${gate.doc.name} (height ${gate.gateHeight})`,
	);
	return [
		promptBody,
		"",
		"## Drop",
		"",
		`feat: ${feat.name}`,
		`doc: ${feat.relPath}`,
		`gist: ${feat.gist}`,
		`today: ${today}`,
		`target: ${(feat.metaScalars.target ?? "").trim() || "(none)"}`,
		...(bridgeRepoNote ? ["", `note: ${bridgeRepoNote}`] : []),
		"",
		"### Blockers",
		"",
		"(none)",
		"",
		"### Repos",
		"",
		...(repoLines.length > 0 ? repoLines : ["(none)"]),
		"",
		"### Gates",
		"",
		"Run each, in this order, from the bridge root:",
		"",
		...(gateLines.length > 0 ? gateLines : ["    (none)"]),
		"",
		"### Close out",
		"",
		`1. Close kb/${feat.id}.md: kind: feat -> kind: memo, plus a \"## Drop report\" section.`,
		"2. nosedive update-backlog",
		"3. Commit and push the bridge.",
		"",
	].join("\n");
}
