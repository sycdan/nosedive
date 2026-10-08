import type { NosediveRc } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import type { KbDoc } from "./kbDocs.js";
import { readKbDocById } from "./kbDocs.js";

/** Name a new work branch from the bridge checkout and the owning feat or backlog. */
export function defaultWorkBranch(
	bridgeDir: string,
	bridgeName: string,
	owner: Pick<KbDoc, "id" | "name">,
): string {
	const branch = gitOutput(bridgeDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (!branch) throw new Error("cannot choose a default work branch: bridge checkout is detached");
	return `${bridgeName}-${branch.replaceAll("/", "-")}/${owner.name}-${owner.id}`;
}

/** Resolve the bridge's own repo doc, rather than using its directory name. */
export function defaultFeatWorkBranch(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	owner: Pick<KbDoc, "id" | "name">,
): string {
	const bridge =
		kbDocs.find((doc) => doc.id === rc.bridge && doc.kind === "repo") ??
		(rc.bridge && rc.kbDir ? readKbDocById(rc.kbDir, rc.bridgeDir, rc.bridge) : undefined);
	if (!bridge || bridge.kind !== "repo")
		throw new Error("cannot choose a default work branch: bridge repo doc is missing");
	return defaultWorkBranch(rc.bridgeDir, bridge.name, owner);
}
