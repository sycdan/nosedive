import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import {
	CONFIG_EXCLUDE_BEGIN,
	CONFIG_EXCLUDE_END,
	FOUNDATION_EXCLUDE_BEGIN,
	FOUNDATION_EXCLUDE_END,
	MANAGED_EXCLUDE_BEGIN,
	MANAGED_EXCLUDE_END,
	REPO_MARKER_EXCLUDE_BEGIN,
	REPO_MARKER_EXCLUDE_END,
} from "./constants.js";
import { formatPath, gitRelPath } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { gitOk, writeFileAtomic } from "./renderPlan.js";

export interface ManagedExcludeSpec {
	begin: string;
	end: string;
	header: string[];
}

export const AGENT_EXCLUDE_SPEC: ManagedExcludeSpec = {
	begin: MANAGED_EXCLUDE_BEGIN,
	end: MANAGED_EXCLUDE_END,
	header: [
		"# kb: 019f5651-5539-76f5-b6bd-351d300194eb",
		"# name: nosedive-managed-local-git-state",
		"# owner: nosedive apply",
		"# reason: generated bridge agent instruction files are local artifacts",
	],
};

export const FOUNDATION_EXCLUDE_SPEC: ManagedExcludeSpec = {
	begin: FOUNDATION_EXCLUDE_BEGIN,
	end: FOUNDATION_EXCLUDE_END,
	header: [
		"# owner: nosedive seed",
		"# reason: package foundation docs are local bootstrap artifacts",
	],
};

export const CONFIG_EXCLUDE_SPEC: ManagedExcludeSpec = {
	begin: CONFIG_EXCLUDE_BEGIN,
	end: CONFIG_EXCLUDE_END,
	header: ["# owner: nosedive seed", "# reason: legacy personal bridge config"],
};

export const REPO_MARKER_EXCLUDE_SPEC: ManagedExcludeSpec = {
	begin: REPO_MARKER_EXCLUDE_BEGIN,
	end: REPO_MARKER_EXCLUDE_END,
	header: [
		"# owner: nosedive hydrate-repo.workspace",
		"# reason: repo ownership marker is local workspace state",
	],
};

export function removeManagedExcludeBlocks(text: string, spec: ManagedExcludeSpec): string {
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (lines[i] !== spec.begin) {
			out.push(lines[i]);
			continue;
		}

		const end = lines.indexOf(spec.end, i + 1);
		if (end === -1) {
			out.push(lines[i]);
			continue;
		}
		i = end;
	}
	return out.join("\n").replace(/\n*$/, "\n");
}

export function renderManagedExcludeBlock(filenames: string[], spec: ManagedExcludeSpec): string {
	return [spec.begin, ...spec.header, ...filenames, spec.end].join("\n");
}

export function replaceManagedExcludeBlock(
	text: string,
	filenames: string[],
	spec: ManagedExcludeSpec,
): string {
	const withoutManaged = removeManagedExcludeBlocks(text, spec);
	const prefix = withoutManaged.trim() ? `${withoutManaged.replace(/\n*$/, "\n")}\n` : "";
	return `${prefix}${renderManagedExcludeBlock(filenames, spec)}\n`;
}

export function updateManagedExclude(
	repoRoot: string,
	filenames: string[],
	warnings: string[],
	spec: ManagedExcludeSpec,
): void {
	const rawExcludePath = gitOutput(repoRoot, ["rev-parse", "--git-path", "info/exclude"]);
	if (!rawExcludePath) {
		warnings.push(`could not resolve git exclude path for ${formatPath(repoRoot)}`);
		return;
	}

	const excludePath = isAbsolute(rawExcludePath)
		? rawExcludePath
		: resolve(repoRoot, rawExcludePath);
	const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	const withoutLegacyConfigBlock =
		spec.begin === CONFIG_EXCLUDE_SPEC.begin
			? removeManagedExcludeBlocks(existing, FOUNDATION_EXCLUDE_SPEC)
			: existing;
	writeFileAtomic(
		excludePath,
		replaceManagedExcludeBlock(withoutLegacyConfigBlock, filenames, spec),
	);
}

export function manageGitState(paths: string[], spec: ManagedExcludeSpec): string[] {
	const warnings: string[] = [];
	const byRepo = new Map<string, string[]>();

	for (const path of paths) {
		const repoRoot = gitOutput(dirname(path), ["rev-parse", "--show-toplevel"]);
		if (!repoRoot) {
			warnings.push(
				`generated file is not inside a git worktree; cannot manage excludes: ${formatPath(path)}`,
			);
			continue;
		}
		const list = byRepo.get(repoRoot) ?? [];
		list.push(path);
		byRepo.set(repoRoot, list);
	}

	for (const [repoRoot, files] of byRepo) {
		const filenames = [...new Set(files.map((file) => gitRelPath(repoRoot, file)))];
		updateManagedExclude(repoRoot, filenames, warnings, spec);

		for (const file of files) {
			const rel = gitRelPath(repoRoot, file);
			if (!gitOk(repoRoot, ["ls-files", "--error-unmatch", "--", rel])) continue;

			if (gitOk(repoRoot, ["update-index", "--skip-worktree", "--", rel])) {
				warnings.push(`tracked generated file marked skip-worktree: ${formatPath(file)}`);
			} else {
				warnings.push(`could not mark tracked generated file skip-worktree: ${formatPath(file)}`);
			}
		}
	}

	return warnings;
}

export function manageGeneratedGitState(paths: string[]): string[] {
	return manageGitState(paths, AGENT_EXCLUDE_SPEC);
}

export function manageFoundationGitState(paths: string[]): string[] {
	return manageGitState(paths, FOUNDATION_EXCLUDE_SPEC);
}
