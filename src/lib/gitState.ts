import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import {
	CONFIG_EXCLUDE_BEGIN,
	CONFIG_EXCLUDE_END,
	FOUNDATION_EXCLUDE_BEGIN,
	FOUNDATION_EXCLUDE_END,
	HANDOFF_RUNBOOK_ID,
	MANAGED_EXCLUDE_BEGIN,
	MANAGED_EXCLUDE_END,
	MANUAL_PRE_PUSH_LINE,
	REPO_MARKER_EXCLUDE_BEGIN,
	REPO_MARKER_EXCLUDE_END,
} from "./constants.js";
import {
	formatPath,
	parseMarkdownDoc,
	parseYamlBlock,
	readNosediveRc,
	resolveFrom,
} from "./coreParsing.js";
import { KbDoc, ScopeRef, loadKbDocs } from "./kbDocs.js";
import { rewriteMarkdownLinks } from "./markdownLinks.js";
import { packageRoot } from "./packageBacklog.js";
import { executableForSpawn, gitOk, gitOutput, writeFileAtomic } from "./renderPlan.js";
import { ensureSafeTargetPath, maybeResolveRepoDoc, uuidLike } from "./repoWorkspaceCore.js";
import { expectedWorktreePath } from "./repoWorktrees.js";

export function commandForSpawn(
	command: string,
	args: string[],
): { command: string; args: string[] } {
	const resolvedCommand = executableForSpawn(command);
	if (
		process.platform === "win32" &&
		(resolvedCommand.endsWith(".cmd") || resolvedCommand.endsWith(".bat"))
	) {
		return {
			command: process.env.ComSpec || "cmd.exe",
			args: ["/d", "/s", "/c", resolvedCommand, ...args],
		};
	}
	return { command: resolvedCommand, args };
}

export function spawnOutputText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return "";
}

export function gitCommonDir(cwd: string): string | undefined {
	const raw = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
	if (!raw) return undefined;
	return resolveFrom(cwd, raw);
}

function loadPackageKbDoc(id: string): { body: string; docPath: string; gist: string } {
	if (!uuidLike(id)) throw new Error(`render requires a UUID-shaped id: ${id}`);
	const docPath = join(packageRoot(), "kb", `${id}.md`);
	if (!existsSync(docPath)) throw new Error(`package kb doc not found: ${id}`);
	if (!statSync(docPath).isFile()) throw new Error(`package kb doc is not a file: ${id}`);
	const doc = parseMarkdownDoc(readFileSync(docPath, "utf8"), docPath);
	return { body: doc.body, docPath, gist: doc.fm.scalars.gist ?? "" };
}

export function renderPackageKbBody(id: string, cwd: string): string {
	const doc = loadPackageKbDoc(id);
	return rewriteMarkdownLinks(doc.body, dirname(doc.docPath), cwd);
}

export function renderPackageKbGist(id: string): string {
	const gist = loadPackageKbDoc(id).gist;
	if (!gist) throw new Error(`package kb doc has no gist: ${id}`);
	return gist;
}

export function printManualHookAdvice(reason: string, io: CommandIo): void {
	io.err(`WARNING: ${reason}`);
	io.err("Add this line to your existing pre-push hook setup:");
	io.err(`  ${MANUAL_PRE_PUSH_LINE}`);
}

/**
 * A hook counts as wired if any non-comment line invokes `_pre-push.hook`,
 * whatever the launcher: `npx nosedive`, a pinned `npx -y nosedive@<version>`,
 * an aliased or globally installed `nosedive`, or `node <root>/dist/cli.js`.
 * The command token is the reliable part to match on; the launcher is not.
 */
export function hookInvokesPrePush(text: string): boolean {
	return text
		.split(/\r?\n/)
		.filter((line) => !/^\s*#/.test(line))
		.some((line) => /(^|[\s'"`/\\])_pre-push\.hook(\s|$|['"`])/.test(line));
}

export interface PilotIdentity {
	name: string;
	email: string;
	missing: string[];
}

export function readPilotIdentity(cwd: string): PilotIdentity {
	const name = gitOutput(cwd, ["config", "user.name"]) ?? "";
	const email = gitOutput(cwd, ["config", "user.email"]) ?? "";
	const missing: string[] = [];
	if (!name) missing.push("user.name");
	if (!email) missing.push("user.email");
	return { name, email, missing };
}

export function pilotIdentityLines(identity: Pick<PilotIdentity, "name" | "email">): string {
	return `nosedive-pilot-name: ${identity.name}\nnosedive-pilot-email: ${identity.email}\n`;
}

export interface WorkspaceDiveMarker {
	present: boolean;
	id?: string;
	error?: string;
}

export function readWorkspaceDiveMarker(workspaceDir: string | undefined): WorkspaceDiveMarker {
	if (!workspaceDir) return { present: false };
	const markerPath = join(workspaceDir, ".nosedive-ref");
	if (!existsSync(markerPath)) return { present: false };
	try {
		const marker = parseYamlBlock(readFileSync(markerPath, "utf8"), markerPath);
		const id = marker.scalars.id?.trim();
		if (!id) return { present: true, error: `${formatPath(markerPath)} is missing id` };
		if (!uuidLike(id))
			return { present: true, error: `${formatPath(markerPath)} id is not UUID-shaped` };
		return { present: true, id };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { present: true, error: detail };
	}
}

export interface DiveWipScope {
	repoId: string;
	ref?: string;
	readOnly: boolean;
}

export interface DiveWipFailure {
	repoId?: string;
	repoPath?: string;
	readOnly?: boolean;
	reasons: string[];
}

export function uniqueDiveWipScopes(scopes: ScopeRef[]): {
	scopes: DiveWipScope[];
	failures: DiveWipFailure[];
} {
	const byRepo = new Map<string, DiveWipScope>();
	const failures: DiveWipFailure[] = [];

	for (const scope of scopes) {
		if (scope.repoId === ".") continue;
		const existing = byRepo.get(scope.repoId);
		if (!existing) {
			byRepo.set(scope.repoId, {
				repoId: scope.repoId,
				ref: scope.ref,
				readOnly: scope.readOnly,
			});
			continue;
		}
		if (existing.ref && scope.ref && existing.ref !== scope.ref) {
			failures.push({
				repoId: scope.repoId,
				reasons: [`conflicting pinned refs in active dive: ${existing.ref} and ${scope.ref}`],
			});
		}
		if (!existing.ref) existing.ref = scope.ref;
		existing.readOnly = existing.readOnly && scope.readOnly;
	}

	return { scopes: [...byRepo.values()], failures };
}

export function hydratedScopedRepoPath(
	kbDocs: KbDoc[],
	scope: DiveWipScope,
	bridgeDir: string,
	workspaceDir: string,
): { path?: string; failure?: DiveWipFailure } {
	const repoDoc = maybeResolveRepoDoc(kbDocs, scope.repoId);
	if (!repoDoc) {
		return {
			failure: {
				repoId: scope.repoId,
				readOnly: scope.readOnly,
				reasons: ["active dive scope names a repo with no kb repo doc; cannot check WIP"],
			},
		};
	}

	let targetPath: string;
	try {
		targetPath = expectedWorktreePath(repoDoc, bridgeDir);
		ensureSafeTargetPath(scope.repoId, targetPath, workspaceDir);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			failure: {
				repoId: scope.repoId,
				readOnly: scope.readOnly,
				reasons: [detail],
			},
		};
	}

	if (!existsSync(targetPath)) return {};
	if (!statSync(targetPath).isDirectory()) {
		return {
			failure: {
				repoId: scope.repoId,
				repoPath: targetPath,
				readOnly: scope.readOnly,
				reasons: ["hydrated repo path exists but is not a directory"],
			},
		};
	}
	if (!gitOutput(targetPath, ["rev-parse", "--show-toplevel"])) return {};
	return { path: targetPath };
}

export function checkScopedRepoWip(
	scope: DiveWipScope,
	repoPath: string,
): DiveWipFailure | undefined {
	const reasons: string[] = [];
	const status = gitOutput(repoPath, ["status", "--porcelain"]);
	if (status === undefined) {
		reasons.push("could not read git status");
	} else if (status.trim() !== "") {
		reasons.push("dirty worktree");
	}

	if (!scope.ref) {
		reasons.push("active dive scope is missing a pinned ref");
	} else {
		const ahead = gitOutput(repoPath, ["rev-list", `${scope.ref}..HEAD`]);
		if (ahead === undefined) {
			reasons.push(`could not compare ${scope.ref}..HEAD`);
		} else if (ahead.trim() !== "") {
			reasons.push(`commits ahead of pinned ref ${scope.ref}`);
		}
	}

	if (reasons.length === 0) return undefined;
	return { repoId: scope.repoId, repoPath, readOnly: scope.readOnly, reasons };
}

export function checkDiveWip(): DiveWipFailure[] {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error(".nosediverc is missing kb");
	if (!rc.workspaceDir) return [];

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (!marker.present) return [];
	if (marker.error || !marker.id) {
		return [{ reasons: [`broken active dive marker: ${marker.error ?? "missing id"}`] }];
	}

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const activeDive = kbDocs.find((doc) => doc.kind === "dive" && doc.id === marker.id);
	if (!activeDive) {
		return [{ reasons: [`broken active dive marker: no kind: dive doc found for ${marker.id}`] }];
	}

	const { scopes, failures } = uniqueDiveWipScopes(activeDive.scopes);
	for (const scope of scopes) {
		const scopedPath = hydratedScopedRepoPath(kbDocs, scope, rc.bridgeDir, rc.workspaceDir);
		if (scopedPath.failure) {
			failures.push(scopedPath.failure);
			continue;
		}
		if (!scopedPath.path) continue;
		const failure = checkScopedRepoWip(scope, scopedPath.path);
		if (failure) failures.push(failure);
	}

	return failures;
}

export function printDiveWipFailure(failures: DiveWipFailure[], io: CommandIo): void {
	io.err("Push failed because the active dive has not been handed off.");
	io.err("");
	for (const failure of failures) {
		const subject = failure.repoId
			? `${failure.readOnly ? "read-only scoped repo" : "scoped repo"} ${failure.repoId}${failure.repoPath ? ` at ${formatPath(failure.repoPath)}` : ""}`
			: "active dive";
		io.err(`- ${subject}: ${failure.reasons.join("; ")}`);
		if (failure.readOnly) {
			io.err(
				"  This read-only scope still contains work to preserve; consider re-scoping it writable.",
			);
		}
	}
	io.err("");
	io.err(`Handoff runbook: ${HANDOFF_RUNBOOK_ID}`);
	io.err("HINT: To learn more, run:");
	io.err(`  npx nosedive render ${HANDOFF_RUNBOOK_ID}`);
}

export function gitRelPath(repoRoot: string, path: string): string {
	return relative(repoRoot, path).replaceAll("\\", "/");
}

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
		warnings.push(`could not resolve git exclude path for ${repoRoot}`);
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
			warnings.push(`generated file is not inside a git worktree; cannot manage excludes: ${path}`);
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
				warnings.push(`tracked generated file marked skip-worktree: ${file}`);
			} else {
				warnings.push(`could not mark tracked generated file skip-worktree: ${file}`);
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
