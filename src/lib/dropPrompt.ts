import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { formatPath, parseMarkdownDoc, type NosediveRc } from "./coreParsing.js";
import type { KbDoc } from "./kbDocs.js";
import type { DropRepo } from "./drop.js";
import type { LandGate } from "./landGates.js";
import { packageDocsOfKind, packageRoot } from "./packageBacklog.js";

export interface EffortRange {
	minimum: number;
	maximum: number;
}

function effortScalar(meta: Record<string, string>, key: string, label: string): number {
	const raw = (meta[key] ?? "").trim();
	if (!raw) throw new Error(`command ${label} has no meta.${key}`);
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 0 || String(value) !== raw) {
		throw new Error(`command ${label} meta.${key} must be a non-negative integer: ${raw}`);
	}
	return value;
}

/**
 * A command that reaches for an agent declares how hard it may try, in its own
 * command doc: the range is part of the command's contract, not a per-run flag,
 * so no caller can talk a cheap command into an expensive model.
 */
export function parseEffortRange(
	commandDocPath: string,
	highestConfigured?: number,
): EffortRange | undefined {
	const label = formatPath(commandDocPath);
	const doc = parseMarkdownDoc(readFileSync(commandDocPath, "utf8"), label);
	const meta = doc.fm.nested.meta ?? {};
	const hasMinimum = meta["minimum-effort"] !== undefined;
	const hasMaximum = meta["maximum-effort"] !== undefined;
	if (!hasMinimum && !hasMaximum) return undefined;
	const minimum = hasMinimum ? effortScalar(meta, "minimum-effort", label) : 0;
	if (!hasMaximum && highestConfigured === undefined) {
		throw new Error(
			`command ${label} has no meta.maximum-effort and the bridge has no agent-effort-<n>`,
		);
	}
	const maximum = hasMaximum ? effortScalar(meta, "maximum-effort", label) : highestConfigured!;
	if (maximum < minimum) {
		throw new Error(`command ${label} meta.maximum-effort is below meta.minimum-effort`);
	}
	return { minimum, maximum };
}

/**
 * The runner memo ships with nosedive, because the grammar for driving a
 * given agent is a fact about that agent rather than about anyone's bridge. A
 * bridge may still hold its own, which is how a runner nosedive has never
 * heard of gets driven -- and how the fixtures drive a fake one.
 */
export function resolveRunnerUsage(kbDocs: KbDoc[], rc: NosediveRc): string {
	const runnerId = (rc.agentRunner ?? "").trim();
	if (!runnerId) throw new Error(`${formatPath(rc.path)} has no agent-runner`);

	for (const packaged of packageDocsOfKind("memo")) {
		const path = join(packageRoot(), "kb", packaged.filename);
		const doc = parseMarkdownDoc(packaged.content, formatPath(path));
		if (doc.fm.scalars.id !== runnerId) continue;
		return requireColdStartUsage(doc.fm.nested.meta?.["cold-start-usage"], formatPath(path));
	}

	const bridgeDoc = kbDocs.find((doc) => doc.id === runnerId);
	if (!bridgeDoc) throw new Error(`agent runner not found: ${runnerId}`);
	return requireColdStartUsage(
		bridgeDoc.metaScalars["cold-start-usage"],
		formatPath(bridgeDoc.path),
	);
}

function requireColdStartUsage(usage: string | undefined, label: string): string {
	const trimmed = (usage ?? "").trim();
	if (!trimmed) throw new Error(`agent runner ${label} has no meta.cold-start-usage`);
	return trimmed;
}

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
