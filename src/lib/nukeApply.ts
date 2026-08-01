import { existsSync, readFileSync, rmSync } from "node:fs";
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

export interface NukeOptions {
	help: boolean;
	config: boolean;
}

export function parseNukeOptions(args: string[]): NukeOptions {
	const options: NukeOptions = { help: false, config: false };
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			options.help = true;
			continue;
		}
		if (arg === "--config") {
			options.config = true;
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
