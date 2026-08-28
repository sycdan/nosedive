import { gitOutput } from "./gitProcess.js";
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
