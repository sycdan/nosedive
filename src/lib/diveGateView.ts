import { type NosediveRc } from "./coreParsing.js";
import { hydratedScopedRepoPath } from "./gitState.js";
import { repoKbDir } from "./kinds.js";
import { loadKbDocs, type KbDoc } from "./kbDocs.js";

/** Gate declarations are dive content; the active dive itself is live bookkeeping. */
export function diveGateView(docs: KbDoc[], dive: KbDoc | undefined, rc: NosediveRc): KbDoc[] {
	const scope = dive?.scopes.find((entry) => entry.repoId === rc.bridge);
	if (!scope) return docs;
	if (!rc.workspaceDir) throw new Error("bridge gate scope requires a workspace");
	const { path, failure } = hydratedScopedRepoPath(docs, scope, rc.bridgeDir, rc.workspaceDir);
	if (failure) throw new Error(failure.reasons.join("; "));
	if (!path) throw new Error("bridge gate scope is not hydrated; jump the dive first");
	return [...loadKbDocs(repoKbDir(path), path).filter((doc) => doc.id !== dive!.id), dive!];
}
