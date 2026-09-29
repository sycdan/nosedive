import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME } from "./constants.js";
import { parseYamlBlock, readNosediveRc, type NosediveRc } from "./coreParsing.js";
import { parseDecks } from "./decks.js";
import { loadKbDocs, readActiveDiveId, type KbDoc } from "./kbDocs.js";
import { repoKbDir } from "./kinds.js";
import { expectedWorktreePath } from "./repoWorktrees.js";

/**
 * The bridge as helm shows it. On a dive that scopes the bridge itself, what
 * the dive has written lives in its `__self` checkout, so that checkout's docs
 * and config are shown -- overlaid on the live bridge, which still holds what
 * the checkout does not, the active dive's own record among it. Otherwise the
 * live bridge alone.
 */
export interface BridgeView {
	rc: NosediveRc;
	docs: KbDoc[];
	/** The dive's checkout of the bridge, when the view reads from one. */
	self?: { root: string; kbDir: string };
}

export function bridgeView(cwd: string): BridgeView {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("helm requires a configured kb directory");
	const live = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const root = selfCheckout(rc, live);
	if (!root) return { rc, docs: live };
	const kbDir = repoKbDir(root);
	const checkout = loadKbDocs(kbDir, root);
	const shown = new Set(checkout.map((doc) => doc.id));
	return {
		rc,
		docs: [...checkout, ...live.filter((doc) => !shown.has(doc.id))],
		self: { root, kbDir },
	};
}

function selfCheckout(rc: NosediveRc, docs: KbDoc[]): string | undefined {
	const active = readActiveDiveId(rc.workspaceDir);
	if (!active || !rc.bridge) return undefined;
	const dive = docs.find((doc) => doc.id === active);
	if (!dive?.scopes.some((scope) => scope.repoId === rc.bridge)) return undefined;
	const repo = docs.find((doc) => doc.id === rc.bridge);
	const root = repo ? expectedWorktreePath(repo, rc.bridgeDir) : undefined;
	return root && existsSync(join(root, BRIDGE_STATE_DIRNAME, BASE_CONFIG_FILENAME))
		? root
		: undefined;
}

/** The decks the view's config lists, read by path: a checkout must not resolve to the bridge around it. */
export function viewDecks(view: BridgeView): string[] {
	const path = view.self
		? join(view.self.root, BRIDGE_STATE_DIRNAME, BASE_CONFIG_FILENAME)
		: view.rc.path;
	const config = parseYamlBlock(readFileSync(path, "utf8"), path);
	return parseDecks(config.raw.decks, view.rc.backlog);
}
