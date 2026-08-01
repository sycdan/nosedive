import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { mintUuid7Lines } from "./uuid7.js";

import { CommandIo } from "./bridgeSetupIo.js";
import { SPLIT_CONFIG_DIRNAME } from "./constants.js";
import {
	baseConfigPath,
	findBridgeConfig,
	formatPath,
	legacyConfigPath,
	localConfigPath,
	noBridgeConfigError,
	readNosediveRc,
} from "./coreParsing.js";
import {
	CONFIG_EXCLUDE_SPEC,
	FOUNDATION_EXCLUDE_SPEC,
	ManagedExcludeSpec,
	manageGeneratedGitState,
	removeManagedExcludeBlocks,
} from "./gitState.js";
import { BridgeConfig, GeneratedFrontmatter, TargetDoc } from "./kbDocs.js";
import { printCommandHelp } from "./packageBacklog.js";
import {
	createApplyPlan,
	gitOutput,
	renderRepoDoc,
	writeAgentFiles,
	writeFileAtomic,
} from "./renderPlan.js";
import {
	ensureSafeTargetPath,
	gitRun,
	parseRepoMarkerStrict,
	realpathStable,
} from "./repoWorkspaceCore.js";
import {
	gitWorktreeEntries,
	markerPathForTarget,
	removeHydratedWorktree,
} from "./repoWorktrees.js";

export function managedExcludeEntries(text: string, spec: ManagedExcludeSpec): string[] {
	const entries: string[] = [];
	const lines = text.split(/\r?\n/);

	for (let i = 0; i < lines.length; i += 1) {
		if (lines[i] !== spec.begin) continue;

		const end = lines.indexOf(spec.end, i + 1);
		if (end === -1) continue;

		for (let j = i + 1; j < end; j += 1) {
			const entry = lines[j]?.trim() ?? "";
			if (!entry || entry.startsWith("#")) continue;
			entries.push(entry);
		}

		i = end;
	}

	return [...new Set(entries)];
}

export function nukeConfig(io: CommandIo): void {
	const resolved = findBridgeConfig(process.cwd());
	if (!resolved) throw noBridgeConfigError();
	const bridgeDir = resolved.bridgeDir;
	const repoRoot = gitOutput(bridgeDir, ["rev-parse", "--show-toplevel"]);
	if (!repoRoot) throw new Error("nosedive nuke must be run inside a git-backed bridge");

	const warnings: string[] = [];
	let removedFiles = 0;

	const rawExcludePath = gitOutput(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
	if (!rawExcludePath) {
		warnings.push(`could not resolve git exclude path for ${repoRoot}`);
	} else {
		const excludePath = isAbsolute(rawExcludePath)
			? rawExcludePath
			: resolve(repoRoot, rawExcludePath);
		const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
		const withoutLegacyConfigBlock = removeManagedExcludeBlocks(existing, FOUNDATION_EXCLUDE_SPEC);
		const withoutManaged = removeManagedExcludeBlocks(
			withoutLegacyConfigBlock,
			CONFIG_EXCLUDE_SPEC,
		);
		if (withoutManaged !== existing) writeFileAtomic(excludePath, withoutManaged);
	}

	for (const path of [
		legacyConfigPath(bridgeDir),
		localConfigPath(bridgeDir),
		baseConfigPath(bridgeDir),
		join(bridgeDir, SPLIT_CONFIG_DIRNAME, ".gitignore"),
	]) {
		if (!existsSync(path)) continue;
		rmSync(path, { force: true });
		removedFiles += 1;
	}

	io.log(`Nuked bridge config; removed ${removedFiles} file${removedFiles === 1 ? "" : "s"}.`);
	if (warnings.length > 0) {
		io.log("");
		io.log("Warnings:");
		for (const warning of warnings) io.log(`  - ${warning}`);
	}
}

function sameStablePath(left: string, right: string): boolean {
	return realpathStable(left) === realpathStable(right);
}

function ensureNoRegisteredWorktreeAtPath(
	sourcePath: string,
	repoId: string,
	targetPath: string,
): void {
	let entries = gitWorktreeEntries(sourcePath, repoId).filter((entry) =>
		sameStablePath(entry.path, targetPath),
	);
	if (entries.length === 0) return;

	gitRun(
		sourcePath,
		["worktree", "prune"],
		`failed to prune stale worktrees for repo ${repoId} at ${formatPath(sourcePath)}`,
	);
	entries = gitWorktreeEntries(sourcePath, repoId).filter((entry) =>
		sameStablePath(entry.path, targetPath),
	);
	if (entries.length === 0) return;

	throw new Error(
		`failed to remove worktree registration for repo ${repoId} at ${formatPath(targetPath)}`,
	);
}

function removeWorkspaceManagedRepo(repoId: string, targetPath: string): void {
	const commonDirRaw = gitOutput(targetPath, ["rev-parse", "--git-common-dir"]);
	if (!commonDirRaw) {
		rmSync(targetPath, { recursive: true, force: true });
		return;
	}

	const sourcePath = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(targetPath, commonDirRaw);
	removeHydratedWorktree(repoId, targetPath, true);
	ensureNoRegisteredWorktreeAtPath(sourcePath, repoId, targetPath);
}

export function nukeWorkspace(io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	if (!rc.workspaceDir) throw new Error(".nosediverc is missing workspace");

	const workspaceDir = rc.workspaceDir;
	if (!existsSync(workspaceDir)) {
		io.log("Nuked workspace; removed 0 repos and 0 marker files.");
		return;
	}
	if (!statSync(workspaceDir).isDirectory()) {
		throw new Error(`workspace is not a directory: ${formatPath(workspaceDir)}`);
	}

	let removedRepos = 0;
	let removedMarkers = 0;
	let removedOtherEntries = 0;
	const workspaceMarkerPath = join(workspaceDir, ".nosedive-ref");
	if (existsSync(workspaceMarkerPath)) {
		rmSync(workspaceMarkerPath, { recursive: true, force: true });
		removedMarkers += 1;
	}

	const dirs = readdirSync(workspaceDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of dirs) {
		const targetPath = join(workspaceDir, entry.name);
		const markerPath = markerPathForTarget(targetPath);
		if (!existsSync(markerPath)) continue;
		if (!statSync(markerPath).isFile()) {
			throw new Error(`managed repo marker is not a file: ${formatPath(markerPath)}`);
		}

		const { id: repoId } = parseRepoMarkerStrict(markerPath);
		ensureSafeTargetPath(repoId, targetPath, workspaceDir);
		removeWorkspaceManagedRepo(repoId, targetPath);
		removedRepos += 1;
	}

	for (const entry of readdirSync(workspaceDir)) {
		rmSync(join(workspaceDir, entry), { recursive: true, force: true });
		removedOtherEntries += 1;
	}

	const otherSummary =
		removedOtherEntries > 0
			? ` and ${removedOtherEntries} other item${removedOtherEntries === 1 ? "" : "s"}`
			: "";
	io.log(
		`Nuked workspace; removed ${removedRepos} repo${removedRepos === 1 ? "" : "s"} and ${removedMarkers} marker file${removedMarkers === 1 ? "" : "s"}${otherSummary}.`,
	);
}

export interface NukeOptions {
	help: boolean;
	config: boolean;
	workspace: boolean;
}

export function parseNukeOptions(args: string[]): NukeOptions {
	const options: NukeOptions = { help: false, config: false, workspace: false };
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg === "--config") {
			options.config = true;
			continue;
		}
		if (arg === "--workspace") {
			options.workspace = true;
			continue;
		}
		throw new Error(`unknown nuke option: ${arg}`);
	}
	return options;
}

export function repoFrontmatter(
	bridge: BridgeConfig,
	docs: TargetDoc[],
): GeneratedFrontmatter | undefined {
	const first = docs[0];
	if (!bridge.effortRef || !first?.repoId) return undefined;
	return {
		effort: bridge.effortRef,
		repoId: first.repoId,
		scopePath: first.scopePath || ".",
	};
}

export function applyWrite(io: CommandIo): void {
	const plan = createApplyPlan();
	const generatedFiles: string[] = [];

	generatedFiles.push(
		...writeAgentFiles(
			plan.bridge.bridgeDir,
			plan.agentFiles,
			renderRepoDoc(plan.bridge.bridgeDir, plan.targets.get(plan.bridge.bridgeDir) ?? []),
		),
	);

	plan.warnings.push(...manageGeneratedGitState(generatedFiles));

	io.log(
		`Wrote bridge docs: ${plan.agentFiles.map((filename) => join(formatPath(plan.bridge.bridgeDir), filename)).join(", ")}`,
	);
	if (plan.warnings.length > 0) {
		io.log("");
		io.log("Warnings:");
		for (const warning of plan.warnings) io.log(`  - ${warning}`);
	}
}

export function mintId(args: string[], io: CommandIo): void {
	const [firstArg] = args;
	if (firstArg === "-h" || firstArg === "--help") {
		printCommandHelp("mint", io);
		return;
	}
	for (const line of mintUuid7Lines(args)) io.log(line);
}
