import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
	BRIDGE_STATE_DIRNAME,
	CURRENT_COMPATIBILITY_LEVEL,
	KNOWN_INSTRUCTION_FILES,
	MANAGED_INSTRUCTIONS_BEGIN,
	MANAGED_INSTRUCTIONS_END,
} from "../lib/constants.js";
import {
	assertWorkspaceInsideBridge,
	baseConfigPath,
	formatPath,
	resolveFrom,
	uuidLike,
} from "../lib/coreParsing.js";
import {
	nosedivePackageVersion,
	printCommandHelp,
	renderTopLevelHelp,
	renderedSurfaceDigest,
	writeNosediveDirGitignore,
} from "../lib/packageBacklog.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { localTrunk, portableLocalPath, renderRepoDoc } from "../lib/recordRepo.js";
import { gitOutput } from "../lib/gitProcess.js";
import { quoteYamlString, writeFileAtomic } from "../lib/renderPlan.js";
import { uuid7AtMs } from "../lib/uuid7.js";

const MANAGED_BEGIN = MANAGED_INSTRUCTIONS_BEGIN;
const MANAGED_END = MANAGED_INSTRUCTIONS_END;
const MARKER_PAIR = [`  ${MANAGED_BEGIN}`, `  ${MANAGED_END}`].join("\n");
const NEW_FILE_HEADING = "# Agent Instructions";
const BRIDGE_SELF_WORKSPACE_PATH = "workspace/__self";

interface InstructionWrite {
	path: string;
	content: string;
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
			writes.push({ path, content: `${NEW_FILE_HEADING}\n\n${block}\n` });
			continue;
		}
		const updated = replaceManagedInstructions(readFileSync(path, "utf8"), block);
		if (updated === undefined) {
			skipped.push(path);
			continue;
		}
		writes.push({ path, content: updated });
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

function mintBacklogMemo(
	bridgeDir: string,
	kbDir: string,
	io: CommandIo,
): { id: string; path: string } {
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
function mintBridgeRepoDoc(
	bridgeDir: string,
	kbDir: string,
	homeBranch: string,
	io: CommandIo,
): string {
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
			// A bridge with no commits yet has no resolvable HEAD, and its
			// configured home branch is the branch it is about to have.
			trunk: localTrunk(bridgeDir) ?? homeBranch,
			cloud: bridgeRemoteUrls(bridgeDir)[0],
			local: portableLocalPath(bridgeDir, bridgeDir),
			registeredBy: "seed",
		}),
	);
	io.log(`Wrote ${formatPath(path)}`);
	return path;
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
			settings.homeBranch = await promptScalar(io, "home-branch", settings.homeBranch);
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

	// Where this run wrote, so the guidance below can name those paths instead of
	// telling the pilot to `git add -A`. A bridge's untracked entries include its
	// hydrated worktrees, and staging one of those commits another repo's checkout
	// into the bridge. Minted documents collapse to their directory: the pilot
	// wants their whole kb staged, and a line of uuid filenames that grows with
	// every mint is one nobody reads.
	const written: string[] = [];

	// At L1 `backlog:` names a kb memo, not a directory. A bridge migrated from
	// L0 already carries the memo its migration minted; a fresh one does not,
	// and without this update-backlog and dump-backlog have nothing to read.
	if (!uuidLike(settings.backlog)) {
		const backlog = mintBacklogMemo(bridgeDir, resolveFrom(bridgeDir, settings.kb), io);
		settings.backlog = backlog.id;
		written.push(dirname(backlog.path));
	}

	const basePath = baseConfigPath(bridgeDir);
	writeFileAtomic(basePath, renderBaseConfig(settings, CURRENT_COMPATIBILITY_LEVEL));
	writeNosediveDirGitignore(bridgeDir);
	io.log(`Wrote ${formatPath(basePath)}`);
	// The directory, not the two files: it holds config.yaml and the ignore rules
	// that keep its cache out of the commit, and nothing else that is not ours.
	written.push(join(bridgeDir, BRIDGE_STATE_DIRNAME));

	// Seed runs at the start of every session, so this has to be a no-op on a
	// bridge that already knows itself. Matching on the cloud remote is the same
	// test the L1 migration's `ensureBridgeRepoDoc` applies.
	const kbDir = resolveFrom(bridgeDir, settings.kb);
	const docs = existsSync(kbDir) ? loadKbDocs(kbDir, bridgeDir) : [];
	const remotes = bridgeRemoteUrls(bridgeDir);
	const knowsItself = docs.some((doc) => {
		if (doc.kind !== "repo") return false;
		// A bridge with no remote has no cloud URL to match on, and would
		// otherwise mint a fresh doc on every run. The workspace path is what it
		// can be recognised by instead.
		if (doc.metaScalars.path === BRIDGE_SELF_WORKSPACE_PATH) return true;
		const rawRemotes = doc.metaRaw.remotes;
		if (!rawRemotes || typeof rawRemotes !== "object" || Array.isArray(rawRemotes)) return false;
		const cloud = (rawRemotes as Record<string, unknown>).cloud;
		return typeof cloud === "string" && remotes.includes(cloud);
	});
	const mintedBridgeRepoDoc = !knowsItself;
	if (mintedBridgeRepoDoc) {
		written.push(dirname(mintBridgeRepoDoc(bridgeDir, kbDir, settings.homeBranch, io)));
	}

	for (const write of instructionWrites) {
		writeFileAtomic(write.path, write.content);
		io.log(`Wrote ${formatPath(write.path)}`);
		written.push(write.path);
	}

	if (mintedBridgeRepoDoc) {
		// Says what is true whether the bridge was cloned or `git init`ed. A clone
		// already carries commits, so "the remote needs a commit" is false there --
		// what still has to hold either way is that scopes resolve against origin,
		// so the home branch has to exist on it.
		io.log(
			`nose: this bridge is now one of its own repos, and scopes resolve against origin, so origin/${settings.homeBranch} has to exist before work can be scoped to it`,
		);
		const addPaths = [...new Set(written.map((path) => formatPath(path)))].sort();
		io.log(`git add ${addPaths.join(" ")}`);
		io.log('git commit -m "seed nosedive"');
		if (remotes.length > 0) {
			io.log(`git push -u origin ${settings.homeBranch}`);
		} else {
			io.log("a remote has to be added and pushed before work can be scoped to the bridge");
		}
	}

	io.log(`nosedive pitch "<what you want to build>"`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(seed, args);
}
