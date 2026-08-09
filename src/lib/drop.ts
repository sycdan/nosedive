import { relative, resolve } from "node:path";

import { toPosixPath, type NosediveRc } from "./coreParsing.js";
import { gitOutput } from "./renderPlan.js";
import { expectedWorktreePath } from "./repoWorktrees.js";
import { resolveRemoteForGit, runGit } from "./repoWorkspaceCore.js";
import { KbDoc } from "./kbDocs.js";
import { effortDocs } from "./repoEffortScopes.js";

export interface DropOptions {
	name: string;
}

export function parseDropArgs(args: string[]): DropOptions {
	let name: string | undefined;
	for (const arg of args) {
		if (arg.startsWith("--")) throw new Error(`unknown drop option: ${arg}`);
		if (name !== undefined) throw new Error(`unexpected drop argument: ${arg}`);
		name = arg;
	}
	const trimmed = (name ?? "").trim();
	if (!trimmed) throw new Error("drop requires a name");
	return { name: trimmed };
}

/**
 * A pilot types a drop's name the way they say it, not the way it is stored:
 * `nosedive drop "judgement day"` has to reach `judgement-day.release.nosedive`.
 * Slugging both sides is the whole of that translation.
 */
export function dropSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function leafSlug(effortName: string): string {
	return effortName.split(".")[0] ?? "";
}

export function resolveDropEffort(kbDocs: KbDoc[], name: string): KbDoc {
	const efforts = effortDocs(kbDocs);
	const byId = efforts.filter((doc) => doc.id === name);
	if (byId.length === 1) return byId[0]!;

	const byName = efforts.filter((doc) => doc.name === name);
	if (byName.length === 1) return byName[0]!;

	const slug = dropSlug(name);
	const bySlug = efforts.filter((doc) => leafSlug(doc.name) === slug || doc.name === slug);
	if (bySlug.length === 1) return bySlug[0]!;
	if (bySlug.length > 1) {
		const names = bySlug.map((doc) => doc.name).sort();
		throw new Error(`drop name is ambiguous: ${name} (${names.join(", ")})`);
	}
	throw new Error(`drop not found: ${name}`);
}

export function todayIsoDate(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface DropRepo {
	doc: KbDoc;
	worktreePath: string;
	trunk: string;
	merge: string;
	branchConvention: string;
	workBranch: string;
	workBranchSha: string;
}

export interface DropReadiness {
	blockers: string[];
	repos: DropRepo[];
}

function linkedDocs(effort: KbDoc, kbDocs: KbDoc[], rel: string): KbDoc[] {
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	return effort.links
		.filter((link) => link.rel === rel)
		.map((link) => byId.get(link.id))
		.filter((doc): doc is KbDoc => doc !== undefined);
}

function cloudRemote(repo: KbDoc): string | undefined {
	const remotes = repo.metaRaw.remotes;
	if (!remotes || typeof remotes !== "object" || Array.isArray(remotes)) return undefined;
	const cloud = (remotes as Record<string, unknown>).cloud;
	return typeof cloud === "string" && cloud.trim() ? cloud.trim() : undefined;
}

function remoteBranchSha(
	bridgeDir: string,
	remote: string,
	branch: string,
): { sha: string; error?: string } {
	const result = runGit(bridgeDir, ["ls-remote", remote, `refs/heads/${branch}`]);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || "unknown git error";
		return { sha: "", error: detail };
	}
	return { sha: result.stdout.trim().split(/\s+/)[0] ?? "" };
}

export function collectDropReadiness(
	effort: KbDoc,
	kbDocs: KbDoc[],
	rc: NosediveRc,
): DropReadiness {
	const blockers: string[] = [];
	const working = linkedDocs(effort, kbDocs, "working");
	if (!working.some((doc) => doc.kind === "memo")) {
		blockers.push(`no landed dive: ${effort.name} has no rel: working link to a memo`);
	}
	for (const dive of working.filter((doc) => doc.kind === "dive")) {
		blockers.push(`open dive: ${dive.name}`);
	}
	for (const child of linkedDocs(effort, kbDocs, "child").filter((doc) => doc.kind === "feat")) {
		blockers.push(`open child feat: ${child.name}`);
	}
	for (const needed of linkedDocs(effort, kbDocs, "needs").filter((doc) => doc.kind === "feat")) {
		blockers.push(`open needed feat: ${needed.name}`);
	}

	const repos: DropRepo[] = [];
	const branch = `${rc.workBranchPrefix ?? "work/"}${effort.name}`;
	for (const scope of effort.scopes) {
		const repo = kbDocs.find((doc) => doc.id === scope.repoId && doc.kind === "repo");
		if (!repo) throw new Error(`scoped repo not found: ${scope.repoId}`);
		const merge = (repo.metaScalars.merge ?? "").trim();
		if (!merge) {
			blockers.push(`repo ${repo.name} has no meta.merge; fix ${repo.relPath}`);
		} else if (merge !== "pull-request" && merge !== "fast-forward") {
			blockers.push(`repo ${repo.name} has unsupported meta.merge ${merge}; fix ${repo.relPath}`);
		}

		const cloud = cloudRemote(repo);
		if (!cloud) {
			blockers.push(`repo ${repo.name} has no meta.remotes.cloud; fix ${repo.relPath}`);
			continue;
		}
		const remoteBranch = remoteBranchSha(
			rc.bridgeDir,
			resolveRemoteForGit(cloud, rc.bridgeDir),
			branch,
		);
		if (remoteBranch.error) {
			blockers.push(`repo ${repo.name} cloud remote could not be read: ${remoteBranch.error}`);
			continue;
		}
		if (!remoteBranch.sha) {
			blockers.push(`repo ${repo.name} is missing work branch ${branch} on its cloud remote`);
			continue;
		}
		repos.push({
			doc: repo,
			worktreePath: toPosixPath(relative(rc.bridgeDir, expectedWorktreePath(repo, rc.bridgeDir))),
			trunk: (repo.metaScalars.trunk ?? "").trim(),
			merge,
			branchConvention: (repo.metaScalars["branch-convention"] ?? "").trim(),
			workBranch: branch,
			workBranchSha: remoteBranch.sha,
		});
	}
	return { blockers, repos };
}

function repoRemoteValues(repo: KbDoc, bridgeDir: string): string[] {
	const remotes = repo.metaRaw.remotes;
	if (!remotes || typeof remotes !== "object" || Array.isArray(remotes)) return [];
	return Object.values(remotes as Record<string, unknown>)
		.filter((value): value is string => typeof value === "string" && value.trim() !== "")
		.map((value) => resolveRemoteForGit(value.trim(), bridgeDir));
}

function bridgeRemoteUrls(bridgeDir: string): string[] {
	const names = gitOutput(bridgeDir, ["remote"])?.split(/\r?\n/).filter(Boolean) ?? [];
	const urls = new Set<string>();
	for (const name of names) {
		for (const args of [
			["remote", "get-url", "--all", name],
			["remote", "get-url", "--push", "--all", name],
		]) {
			const result = runGit(bridgeDir, args);
			if (result.status === 0) {
				for (const url of result.stdout.split(/\r?\n/).filter(Boolean)) urls.add(url.trim());
			}
		}
	}
	return [...urls].map((url) => resolveRemoteForGit(url, bridgeDir));
}

export function resolveBridgeRepoDoc(kbDocs: KbDoc[], bridgeDir: string): KbDoc | undefined {
	const remoteUrls = new Set(bridgeRemoteUrls(bridgeDir).map((url) => resolve(url)));
	for (const repo of kbDocs.filter((doc) => doc.kind === "repo")) {
		for (const remote of repoRemoteValues(repo, bridgeDir)) {
			if (remoteUrls.has(resolve(remote))) return repo;
		}
	}
	return undefined;
}
