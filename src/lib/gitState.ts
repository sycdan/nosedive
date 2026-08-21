import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import { HANDOFF_RUNBOOK_ID } from "./constants.js";
import {
	formatPath,
	parseMarkdownDoc,
	parseYamlBlock,
	readNosediveRc,
	resolveFrom,
	uuidLike,
} from "./coreParsing.js";
import { KbDoc, ScopeRef, loadKbDocs } from "./kbDocs.js";
import { gitOutput, readGitAuthorIdentity } from "./gitProcess.js";
import { rewriteMarkdownLinks } from "./markdownLinks.js";
import { packageRoot } from "./packageBacklog.js";
import { executableForSpawn } from "./renderPlan.js";
import { ensureSafeTargetPath, maybeResolveRepoDoc } from "./repoWorkspaceCore.js";
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
	const doc = parseMarkdownDoc(readFileSync(docPath, "utf8"), formatPath(docPath));
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
	const { name, email } = readGitAuthorIdentity(cwd);
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
		const marker = parseYamlBlock(readFileSync(markerPath, "utf8"), formatPath(markerPath));
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
	workBranch?: string;
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
				workBranch: scope.workBranch,
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
		// The writable entry decides where the repo lands, matching the rule below
		// that one writable mention makes the merged scope writable.
		if (!existing.workBranch) existing.workBranch = scope.workBranch;
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
