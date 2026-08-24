import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import {
	CommandIo,
	loadSplitRcSettings,
	migrateBridgeConfig,
	parseSeedOptions,
	promptScalar,
	renderBaseConfig,
} from "../lib/bridgeSetupIo.js";
import {
	CURRENT_COMPATIBILITY_LEVEL,
	KNOWN_INSTRUCTION_FILES,
	MANAGED_INSTRUCTIONS_BEGIN,
	MANAGED_INSTRUCTIONS_END,
} from "../lib/constants.js";
import { commitMessage } from "../lib/commitProvenance.js";
import {
	assertWorkspaceInsideBridge,
	baseConfigPath,
	formatPath,
	resolveFrom,
	toPosixPath,
	uuidLike,
} from "../lib/coreParsing.js";
import {
	nosedivePackageVersion,
	printCommandHelp,
	renderTopLevelHelp,
	renderedSurfaceDigest,
	writeNosediveDirGitignore,
} from "../lib/packageBacklog.js";
import { loadKbDocs, readKbDocById } from "../lib/kbDocs.js";
import { localTrunk, portableLocalPath, renderRepoDoc } from "../lib/recordRepo.js";
import { gitOutput, runGit } from "../lib/gitProcess.js";
import { quoteYamlString, writeFileAtomic } from "../lib/renderPlan.js";
import { gitRun } from "../lib/repoWorkspaceCore.js";
import { uuid7AtMs } from "../lib/uuid7.js";

const MANAGED_BEGIN = MANAGED_INSTRUCTIONS_BEGIN;
const MANAGED_END = MANAGED_INSTRUCTIONS_END;
const MARKER_PAIR = ["```md", MANAGED_BEGIN, MANAGED_END, "```"].join("\n");
const NEW_FILE_HEADING = "# Agent Instructions";
const BRIDGE_SELF_WORKSPACE_PATH = "workspace/__self";

interface InstructionWrite {
	path: string;
	content: string;
	changed: boolean;
}

interface MintedDoc {
	id: string;
	path: string;
}

function renderManagedInstructions(): string {
	const help = renderTopLevelHelp({ agents: true }).trim();
	const longestBacktickRun = Math.max(
		2,
		...[...help.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(longestBacktickRun + 1);
	return [
		MANAGED_BEGIN,
		`<!-- nosedive v=${nosedivePackageVersion()} surface=${renderedSurfaceDigest()} -->`,
		"- `nosedive` commands may issue instructions, which you should follow with highest priority.",
		"- If any `nosedive <command>` output line starts with `nose:`, it is a direct call to attention; handle it before tackling other work.",
		"- Before starting work, greet the pilot casually.",
		"- Call `nosedive preflight` before your first reply to the pilot in a session, but only if `nosedive-pilot-name` is unknown.",
		"",
		"These commands are available to you:",
		"",
		fence,
		help,
		fence,
		MANAGED_END,
	].join("\n");
}

function replaceManagedInstructions(text: string, block: string): string | undefined {
	const lines = text.split(/\r?\n/);
	const begin = lines.indexOf(MANAGED_BEGIN);
	if (begin === -1) return undefined;
	const end = lines.indexOf(MANAGED_END, begin + 1);
	if (end === -1) return undefined;
	return [...lines.slice(0, begin), ...block.split("\n"), ...lines.slice(end + 1)]
		.join("\n")
		.replace(/\n*$/, "\n");
}

/** Explicit `--file` paths, or the known instruction files that already exist in the bridge. */
function resolveInstructionTargets(bridgeDir: string, files: string[]): string[] {
	if (files.length > 0) return files.map((file) => resolveFrom(bridgeDir, file));
	const found = KNOWN_INSTRUCTION_FILES.map((name) => join(bridgeDir, name)).filter((path) =>
		existsSync(path),
	);
	if (found.length === 0) return [join(bridgeDir, "AGENTS.md")];
	return found;
}

/**
 * Decide what each target gets before anything is written: a named file that
 * does not exist yet is created whole, an existing one only ever has the span
 * between its markers replaced, and one without markers is left alone -- seed
 * does not guess where the pilot wants the block.
 */
function planAgentInstructions(paths: string[], io: CommandIo): InstructionWrite[] {
	const block = renderManagedInstructions();
	const writes: InstructionWrite[] = [];
	const skipped: string[] = [];

	for (const path of paths) {
		if (!existsSync(path)) {
			writes.push({ path, content: `${NEW_FILE_HEADING}\n\n${block}\n`, changed: true });
			continue;
		}
		const existing = readFileSync(path, "utf8");
		const updated = replaceManagedInstructions(existing, block);
		if (updated === undefined) {
			skipped.push(path);
			continue;
		}
		writes.push({ path, content: updated, changed: updated !== existing });
	}

	// A capturing io drops its buffered output when a command throws, so the
	// no-file-seeded failure has to carry the skipped paths in its own message.
	if (writes.length === 0) {
		throw new Error(
			`no agent instructions file could be seeded: ${skipped.map(formatPath).join(", ")} ` +
				`has no nosedive managed instructions block. Add this marker pair, then run seed again:\n${MARKER_PAIR}`,
		);
	}
	for (const path of skipped) {
		io.err(
			`skipped ${formatPath(path)}: no nosedive managed instructions block. ` +
				`Add this marker pair, then run seed again:\n${MARKER_PAIR}`,
		);
	}
	return writes;
}

function mintBacklogMemo(bridgeDir: string, kbDir: string, io: CommandIo): MintedDoc {
	const id = uuid7AtMs(Date.now());
	const name = basename(bridgeDir);
	const path = join(kbDir, `${id}.md`);
	mkdirSync(kbDir, { recursive: true });
	writeFileAtomic(
		path,
		[
			"---",
			"kind: memo",
			`id: ${id}`,
			`name: backlog.${name}`,
			`gist: ${quoteYamlString(`Current backlog for ${name}.`)}`,
			"---",
			"",
			"# Backlog",
			"",
			// What `update-backlog` renders for a memo that links no work, so a
			// fresh bridge starts holding the body the renderer would give it. The
			// old `## Current efforts` stub was a section heading no render
			// produces: sections are named for the rel predicate that links them,
			// so a `current.feat` edge renders `## Current`, and until a bridge has
			// one there is no section at all.
			"The backlog links no work.",
			"",
		].join("\n"),
	);
	io.log(`Wrote ${formatPath(path)}`);
	return { id, path };
}

/**
 * Every remote URL the bridge has, `origin` first. Order decides which one is
 * recorded as `cloud`, and `git remote` sorts by remote name, so without this
 * an alphabetically earlier remote would outrank the one the pilot pushes to.
 */
function bridgeRemoteUrls(bridgeDir: string): string[] {
	const names = (gitOutput(bridgeDir, ["remote"]) ?? "").split(/\r?\n/).filter(Boolean);
	const ordered = names.includes("origin")
		? ["origin", ...names.filter((name) => name !== "origin")]
		: names;
	const urls = ordered
		.map((name) => gitOutput(bridgeDir, ["remote", "get-url", name]))
		.filter((url): url is string => Boolean(url));
	return [...new Set(urls)];
}

/**
 * The bridge as one of its own repos, so a fresh bridge has something to scope a
 * dive to without the pilot discovering `record.repo` first. Rendered by
 * `record.repo`'s own renderer rather than a second one: two renderers for one
 * `kind: repo` shape would drift, and this doc has to hydrate through exactly
 * the same path as any other.
 *
 * `__self` is the workspace path, not the name -- `assertSlug` is kebab-case
 * only. The name is the bridge directory's basename, which is what the L1
 * migration's `ensureBridgeRepoDoc` also uses.
 */
function mintBridgeRepoDoc(bridgeDir: string, kbDir: string, io: CommandIo): MintedDoc {
	const id = uuid7AtMs(Date.now());
	const name = basename(bridgeDir);
	const path = join(kbDir, `${id}.md`);
	mkdirSync(kbDir, { recursive: true });
	writeFileAtomic(
		path,
		renderRepoDoc({
			id,
			name,
			workspacePath: BRIDGE_SELF_WORKSPACE_PATH,
			// The literal is the last resort for a repo with no resolvable HEAD.
			trunk: localTrunk(bridgeDir) ?? "main",
			cloud: bridgeRemoteUrls(bridgeDir)[0],
			local: portableLocalPath(bridgeDir, bridgeDir),
			registeredBy: "seed",
		}),
	);
	io.log(`Wrote ${formatPath(path)}`);
	return { id, path };
}

function commitAndPushSeed(
	bridgeDir: string,
	paths: string[],
	bridgeBranch: string,
	surfaceChanged: boolean,
	io: CommandIo,
): void {
	const pathspecs = paths.map((path) => toPosixPath(relative(bridgeDir, path)));
	const hasHead = Boolean(gitOutput(bridgeDir, ["rev-parse", "--verify", "HEAD"]));
	const diff = hasHead
		? runGit(bridgeDir, ["diff", "--quiet", "HEAD", "--", ...pathspecs])
		: undefined;
	if (diff && diff.status !== 0 && diff.status !== 1) {
		const detail = diff.stderr.trim() || diff.stdout.trim() || "unknown git error";
		throw new Error(`failed to inspect seed changes: ${detail}`);
	}
	const trackedChanged = diff?.status === 1;
	const untracked = gitRun(
		bridgeDir,
		["ls-files", "--others", "--exclude-standard", "--", ...pathspecs],
		"failed to inspect untracked seed paths",
	);
	if (!trackedChanged && !untracked) {
		io.log("Bridge was already up to date; nothing was committed");
		return;
	}

	gitRun(bridgeDir, ["add", "--", ...pathspecs], "failed to stage seed files");
	const subject = surfaceChanged
		? `seed(nosedive@${nosedivePackageVersion()}): surface changed to ${renderedSurfaceDigest()}`
		: `seed(nosedive@${nosedivePackageVersion()}): surface did not change`;
	// A pathspec commit takes only seed's files and leaves the pilot's unrelated index entries staged.
	gitRun(
		bridgeDir,
		["commit", "-m", commitMessage(subject), "--", ...pathspecs],
		"failed to commit seed files",
	);
	io.log(`Committed ${subject}`);

	const upstream = gitOutput(bridgeDir, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	if (!upstream) {
		try {
			gitRun(
				bridgeDir,
				["push", "-u", "origin", bridgeBranch],
				"failed to push seeded bridge; seed files are committed locally",
			);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}\ngit push -u origin ${bridgeBranch}`,
			);
		}
		io.log(`Pushed to origin/${bridgeBranch}`);
		return;
	}
	const [remote, ...branchParts] = upstream.split("/");
	const branch = branchParts.join("/");
	// Fetch + merge --ff-only instead of `git pull --ff-only`: a pilot with
	// pull.rebase set globally would otherwise have that override --ff-only.
	gitRun(bridgeDir, ["fetch", remote!], "failed to fetch bridge remote before seed push");
	gitRun(
		bridgeDir,
		["merge", "--ff-only", upstream],
		"failed to fast-forward bridge before seed push; resolve manually and retry",
	);
	try {
		gitRun(bridgeDir, ["push"], "failed to push seeded bridge; seed files are committed locally");
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\ngit push`);
	}
	io.log(`Pushed to ${remote}/${branch}`);
}

async function seed(args: string[], io: CommandIo): Promise<void> {
	const options = parseSeedOptions(args);
	if (options.help) {
		printCommandHelp("seed", io);
		return;
	}

	const bridgeDir = process.cwd();
	if (!gitOutput(bridgeDir, ["rev-parse", "--show-toplevel"])) {
		throw new Error("nosedive seed must be run inside a git repository");
	}
	// Checked before the migration and before anything is written, because it
	// stops costing nothing the moment seed succeeds. Every scope pin resolves
	// against `origin`, so a bridge without one gets as far as `record.dive` and
	// dies on `fatal: Needed a single revision` -- a message that names neither
	// the cause nor the fix, three commands after the point it could have been
	// fixed for free.
	if (!gitOutput(bridgeDir, ["remote", "get-url", "origin"])) {
		throw new Error(
			"nosedive seed needs a remote named origin, because every scope pin resolves against it. " +
				"Create an empty repository -- GitHub's free tier is enough -- then either clone it and " +
				"seed inside the clone, or run `git remote add origin <url>` here.",
		);
	}

	await migrateBridgeConfig(bridgeDir, io);

	// Classified before prompting and before the config write, so an unusable
	// set of instruction files costs the pilot nothing.
	const instructionWrites = planAgentInstructions(
		resolveInstructionTargets(bridgeDir, options.files),
		io,
	);

	const settings = loadSplitRcSettings(bridgeDir);

	if (!options.headless) {
		try {
			settings.workspace = await promptScalar(io, "workspace", settings.workspace);
			settings.backlog = await promptScalar(io, "backlog", settings.backlog);
			settings.kb = await promptScalar(io, "kb", settings.kb);
			settings.workBranchPrefix = await promptScalar(
				io,
				"work-branch-prefix",
				settings.workBranchPrefix,
			);
		} finally {
			io.close();
		}
	}

	// After prompting, so a typed workspace is checked too, and before anything
	// is minted or written -- a bridge that cannot be resolved from inside its
	// own workspace is not worth half-creating.
	assertWorkspaceInsideBridge(bridgeDir, settings.workspace);

	// At L1 `backlog:` names a kb memo, not a directory. A bridge migrated from
	// L0 already carries the memo its migration minted; a fresh one does not,
	// and without this update-backlog and dump-backlog have nothing to read.
	const mintedBacklogMemo = !uuidLike(settings.backlog)
		? mintBacklogMemo(bridgeDir, resolveFrom(bridgeDir, settings.kb), io)
		: undefined;
	if (mintedBacklogMemo) settings.backlog = mintedBacklogMemo.id;

	// Seed runs at the start of every session, so this has to be a no-op on a
	// bridge that already knows itself. Matching on the cloud remote is the same
	// test the L1 migration's `ensureBridgeRepoDoc` applies. This sweep also
	// backfills `bridge:` for bridges seeded before that config key existed.
	const kbDir = resolveFrom(bridgeDir, settings.kb);
	const docs = existsSync(kbDir) ? loadKbDocs(kbDir, bridgeDir) : [];
	const remotes = bridgeRemoteUrls(bridgeDir);
	const selfDoc = docs.find((doc) => {
		if (doc.kind !== "repo") return false;
		// Recognises the bridge's own repo doc even after its remote URL has
		// changed, which matching on `cloud` alone would not.
		if (doc.metaScalars.path === BRIDGE_SELF_WORKSPACE_PATH) return true;
		const rawRemotes = doc.metaRaw.remotes;
		if (!rawRemotes || typeof rawRemotes !== "object" || Array.isArray(rawRemotes)) return false;
		const cloud = (rawRemotes as Record<string, unknown>).cloud;
		return typeof cloud === "string" && remotes.includes(cloud);
	});
	if (selfDoc && !selfDoc.id) {
		throw new Error(`bridge repo document ${formatPath(selfDoc.path)} has no id`);
	}
	const mintedBridgeRepoDoc = selfDoc ? undefined : mintBridgeRepoDoc(bridgeDir, kbDir, io);
	settings.bridge = selfDoc?.id ?? mintedBridgeRepoDoc!.id;
	const bridgeBranch = readKbDocById(kbDir, bridgeDir, settings.bridge)?.repoBaseBranch ?? "main";

	const basePath = baseConfigPath(bridgeDir);
	writeFileAtomic(basePath, renderBaseConfig(settings, CURRENT_COMPATIBILITY_LEVEL));
	writeNosediveDirGitignore(bridgeDir);
	const nosediveGitignorePath = join(bridgeDir, ".nosedive", ".gitignore");
	io.log(`Wrote ${formatPath(basePath)}`);

	for (const write of instructionWrites) {
		writeFileAtomic(write.path, write.content);
		io.log(`Wrote ${formatPath(write.path)}`);
	}

	commitAndPushSeed(
		bridgeDir,
		[
			basePath,
			nosediveGitignorePath,
			...(mintedBacklogMemo ? [mintedBacklogMemo.path] : []),
			...(mintedBridgeRepoDoc ? [mintedBridgeRepoDoc.path] : []),
			...instructionWrites.map((write) => write.path),
		],
		bridgeBranch,
		instructionWrites.some((write) => write.changed),
		io,
	);

	// Headed, because these follow a run of `Wrote <path>` lines and three bare
	// commands under those read as more of the same rather than as a choice.
	io.log("");
	io.log("Next steps:");
	io.log("nosedive preflight -- what needs attention now");
	io.log("nosedive record.feat -- start something new");
	io.log("nosedive help -- what else nosedive can do");
	io.log(`or ask your agent "What's next?"`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(seed, args);
}
