import { gitOutput, runGit } from "./gitProcess.js";
import { gitRun } from "./repoWorkspaceCore.js";

/**
 * The remote a bridge answers questions about itself with: `origin` when it has
 * one, otherwise the first remote that carries a URL. A remote entry with no
 * URL configured is not a remote anything can be asked of.
 */
export function preferredBridgeRemote(bridgeDir: string): string | undefined {
	const remotes = (gitOutput(bridgeDir, ["remote"])?.split(/\r?\n/).filter(Boolean) ?? []).filter(
		(remote) => gitOutput(bridgeDir, ["config", "--get", `remote.${remote}.url`]),
	);
	if (remotes.length === 0) return undefined;
	return remotes.includes("origin") ? "origin" : remotes[0];
}

export function bridgeTrunkBranch(bridgeDir: string, remote: string): string | undefined {
	const remoteHead = gitRun(
		bridgeDir,
		["ls-remote", "--symref", remote, "HEAD"],
		`failed to resolve bridge trunk from remote ${remote}`,
	);
	return /^ref:\s+refs\/heads\/(.+)\s+HEAD$/m.exec(remoteHead)?.[1]?.trim();
}

/**
 * Refuses a bridge whose HEAD and upstream have diverged, as a helm Pull or
 * Squash off trunk leaves it until pushed. Every dive verb fast-forwards the
 * bridge before pushing, which would fail only after the verb had written, so
 * each calls this first. Behind or ahead is fine; no upstream is left to the
 * verb's own "no upstream" error. Returns the upstream, if any.
 */
export function assertBridgeInStep(bridgeDir: string): string | undefined {
	const upstream = gitOutput(bridgeDir, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	if (!upstream) return undefined;
	const [remote] = upstream.split("/");
	// A failed fetch is not divergence: judge by the last-known upstream and
	// leave an unreachable remote to the verb's own fetch, which says so.
	runGit(bridgeDir, ["fetch", remote!]);
	const ancestor = (a: string, b: string): boolean =>
		runGit(bridgeDir, ["merge-base", "--is-ancestor", a, b]).status === 0;
	if (ancestor("HEAD", "@{upstream}") || ancestor("@{upstream}", "HEAD")) return upstream;
	const branch = gitOutput(bridgeDir, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
	throw new Error(
		`bridge ${branch} has diverged from ${upstream}; push it (helm's Push) or pull first, then retry`,
	);
}

/**
 * Whether this bridge is the one its pilot reads. A bridge checked out on its
 * own trunk is the working copy the pilot has open; a bridge on any other
 * branch is a checkout somebody made for work nobody is watching, so anything
 * left in its workspace is unreadable until it is packed.
 *
 * Unresolvable answers false, and the asymmetry is the reason: a visible diver
 * wrongly told to pack costs one re-jump, while a headless diver wrongly told
 * to stop strands the work in a workspace nobody can read, with the dive still
 * held by its diver.
 */
export function bridgeIsOnTrunk(bridgeDir: string): boolean {
	const branch = gitOutput(bridgeDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!branch) return false;
	const remote = preferredBridgeRemote(bridgeDir);
	if (!remote) return false;
	return branch === bridgeTrunkBranch(bridgeDir, remote);
}
