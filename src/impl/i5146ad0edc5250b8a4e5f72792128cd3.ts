import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { commitMessage } from "../lib/commitProvenance.js";
import { NO_ACTIVE_DIVE_ERROR_ID } from "../lib/constants.js";
import {
	formatPath,
	parseMarkdownDoc,
	readNosediveRc,
	stringifyYaml,
	toPosixPath,
} from "../lib/coreParsing.js";
import { readWorkspaceDiveMarker } from "../lib/gitState.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { gitOutput, writeFileAtomic } from "../lib/renderPlan.js";
import { resolveEffortDoc } from "../lib/repoEffortScopes.js";
import { gitRun } from "../lib/repoWorkspaceCore.js";

/** Mirrors packDive's stash-except-staged: never `-u`, workspace repo checkouts
 * are untracked nested `.git` dirs that don't round-trip through stash/pop. */
function stashExceptStaged(bridgeDir: string): boolean {
	const before = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	gitRun(
		bridgeDir,
		["stash", "push", "--keep-index", "-m", "nosedive bail: temporary stash"],
		"failed to stash bridge state before bail push",
	);
	const after = gitOutput(bridgeDir, ["rev-parse", "--verify", "-q", "refs/stash"]);
	return before !== after;
}

function commitAndPushBail(
	bridgeDir: string,
	divePath: string,
	diveName: string,
	reason: string,
	effortId?: string,
): void {
	const relPath = toPosixPath(relative(bridgeDir, divePath));
	gitRun(bridgeDir, ["add", "--", relPath], "failed to stage bailed dive");

	const stashed = stashExceptStaged(bridgeDir);
	try {
		const upstream = gitOutput(bridgeDir, [
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{upstream}",
		]);
		if (!upstream)
			throw new Error("bridge has no upstream to push to; configure one before bailing");
		const [remote] = upstream.split("/");
		gitRun(bridgeDir, ["fetch", remote!], "failed to fetch bridge remote before bail push");
		gitRun(
			bridgeDir,
			["merge", "--ff-only", upstream],
			"failed to fast-forward bridge before bail push; resolve manually and retry",
		);
		gitRun(
			bridgeDir,
			["commit", "-m", commitMessage(`bail(${diveName}): ${reason}`, effortId)],
			"failed to commit bailed dive",
		);
		gitRun(
			bridgeDir,
			["push"],
			"failed to push bridge after bail; dive is committed locally as a memo",
		);
	} finally {
		if (stashed)
			gitRun(bridgeDir, ["stash", "pop"], "failed to restore stashed bridge state after bail push");
	}
}

/** The reason is the one thing only the pilot knows, so it is a required flag:
 * a flag with a value cannot be typed by accident, and no default can stand in
 * for it. Parsed and enforced before any read or write, so a refusal changes
 * nothing. */
function parseBailArgs(args: string[]): string {
	let reason: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--reason") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("--"))
				throw new Error("bail --reason requires a value");
			reason = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--reason=")) {
			reason = arg.slice("--reason=".length);
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown bail option: ${arg}`);
		throw new Error(`unexpected bail argument: ${arg}; pass the reason as --reason "<why>"`);
	}
	if (reason === undefined) throw new Error('bail requires --reason "<why>"');
	const trimmed = reason.trim();
	if (!trimmed) throw new Error("bail reason cannot be empty");
	return trimmed;
}

function bail(args: string[], io: CommandIo): void {
	const reason = parseBailArgs(args);
	const rc = readNosediveRc(process.cwd());

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) throw new Error(NO_ACTIVE_DIVE_ERROR_ID);
	if (marker.error || !marker.id)
		throw new Error(`broken active dive marker: ${marker.error ?? "missing id"}`);

	if (!rc.kbDir) throw new Error("bail requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const dive = kbDocs.find((doc) => doc.id === marker.id);
	if (!dive) throw new Error(`active dive ${marker.id} not found in kb`);

	const markerPath = join(rc.workspaceDir!, ".nosedive-ref");
	const relDivePath = relative(rc.bridgeDir, dive.path);
	const status = gitOutput(rc.bridgeDir, ["status", "--porcelain", "--", relDivePath]) ?? "";

	if (status.startsWith("??")) {
		unlinkSync(dive.path);
		if (existsSync(markerPath)) unlinkSync(markerPath);
		io.log(`bailed "${dive.gist}" (never committed) -- deleted ${formatPath(dive.path)}`);
		return;
	}

	const text = readFileSync(dive.path, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(dive.path));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in frontmatter in ${formatPath(dive.path)}`);

	doc.set("kind", "memo");
	doc.set("gist", `${dive.gist} -- bailed: ${reason}`);

	writeFileAtomic(dive.path, ["---", stringifyYaml(doc).trimEnd(), "---", parsed.body].join("\n"));

	commitAndPushBail(
		rc.bridgeDir,
		dive.path,
		dive.name,
		reason,
		dive.effortRef ? resolveEffortDoc(kbDocs, rc, dive.effortRef).id : undefined,
	);
	if (existsSync(markerPath)) unlinkSync(markerPath);
	io.log(`bailed "${dive.gist}" -- converted to memo, reason: ${reason}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(bail, args);
}
