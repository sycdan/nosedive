import { join } from "node:path";

import { gitOutput, writeFileAtomic } from "./renderPlan.js";
import { gitRun, runGit } from "./repoWorkspaceCore.js";

/** A captured patch file, not yet wrapped in its `kind: memo` doc. */
export interface CapturedPatch {
	repoId: string;
	patchRelPath: string;
	patchAbsPath: string;
	sha?: string;
	/** Full commit message (subject + body), only set for a real commit. */
	commitMessage?: string;
	dirty?: boolean;
}

export function writeArtifact(
	kbDir: string,
	id: string,
	content: string,
): { relPath: string; absPath: string } {
	const absPath = join(kbDir, "artifacts", `${id}.patch`);
	writeFileAtomic(absPath, content);
	return { relPath: `kb/artifacts/${id}.patch`, absPath };
}

/**
 * Patch/diff bytes must round-trip exactly -- `gitRun`'s blanket `.trim()`
 * silently strips the trailing newline (and, worse, a trailing
 * whitespace-only context line) that `format-patch`/`diff` output ends
 * with, and `git am`/`git apply` then reject the result as corrupt. Every
 * call capturing a `.patch` artifact's actual content must use this, not
 * `gitRun`.
 */
export function gitRunPatch(cwd: string, args: string[], label: string): string {
	const result = runGit(cwd, args);
	if (result.status === 0) return result.stdout;
	const detail = result.stderr.trim() || result.stdout.trim() || "unknown git error";
	throw new Error(`${label}: ${detail}`);
}

export function listAheadCommits(repoPath: string, pin: string, repoId: string): string[] {
	const raw = gitRun(
		repoPath,
		["rev-list", "--reverse", `${pin}..HEAD`],
		`failed to list commits ahead of pin for repo ${repoId}`,
	);
	return raw ? raw.split(/\r?\n/).filter(Boolean) : [];
}

export function untrackedFiles(repoPath: string): string[] {
	const raw = gitOutput(repoPath, ["ls-files", "--others", "--exclude-standard"]);
	return raw ? raw.split(/\r?\n/).filter(Boolean) : [];
}

/**
 * `git diff <commit>` (no `--cached`) already folds staged and unstaged
 * changes into one patch against that commit; intent-to-add is what pulls
 * untracked files into that same diff without ever writing their blobs to a
 * real commit. The intent-to-add markers are reset afterward so a failed pack
 * leaves the worktree exactly as it found it.
 */
export function captureDirtyPatch(repoPath: string, repoId: string): string | undefined {
	const status = gitOutput(repoPath, ["status", "--porcelain"]);
	if (!status || !status.trim()) return undefined;

	const untracked = untrackedFiles(repoPath);
	if (untracked.length > 0) {
		gitRun(
			repoPath,
			["add", "--intent-to-add", "--", ...untracked],
			`failed to stage untracked files for repo ${repoId} pack`,
		);
	}
	try {
		return gitRunPatch(
			repoPath,
			["diff", "--binary", "HEAD"],
			`failed to capture dirty diff for repo ${repoId}`,
		);
	} finally {
		if (untracked.length > 0) {
			gitRun(
				repoPath,
				["reset", "--", ...untracked],
				`failed to unstage intent-to-add markers for repo ${repoId}`,
			);
		}
	}
}
