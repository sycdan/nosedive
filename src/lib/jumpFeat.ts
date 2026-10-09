import type { CommandIo } from "./bridgeSetupIo.js";
import { uuidLike, type NosediveRc } from "./coreParsing.js";
import { resolveBridgeDocRef } from "./diveScopes.js";
import { assertJumpable } from "./jumpable.js";
import { readActiveDiveId, type KbDoc } from "./kbDocs.js";
import { recordDive } from "./recordDive.js";
import { featRefOf } from "./repoFeatScopes.js";
import { resolveRepoRef } from "./repoLinks.js";
import { managedDiveName, titleFromSlug } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

/**
 * `jump <feat>`: diving into a feat without a planned dive. A ref naming a doc
 * that is not a dive records one on it -- named like any dive, titled with
 * that name, gisted with when it began, and briefed as unplanned -- and hands back its id,
 * so the jump proceeds exactly as `jump <dive>` would. Any other ref, and no
 * ref, comes back as given for jump to resolve and refuse as it always has.
 */
export function diveToJump(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	ref: string | undefined,
	io: CommandIo,
): string | undefined {
	if (!ref) return ref;
	// A feat in another repo is named `<repo-quid>:<path>`, and is always a feat jump.
	let feat: KbDoc | undefined = resolveRepoRef(kbDocs, rc, ref);
	try {
		feat ??= resolveBridgeDocRef(rc.bridgeDir, kbDocs, ref);
	} catch {
		return ref;
	}
	// A dive jumps as itself; a repo is not work, so jump refuses it as it always has.
	if (feat.kind === "dive" || feat.kind === "repo") return ref;
	// What makes a doc a feat is the root reaching it through `.feat` links, not its kind.
	assertJumpable(rc, kbDocs, feat);
	const active = readActiveDiveId(rc.workspaceDir);
	if (active)
		throw new Error(
			`dive ${active} is active; land, pack or bail it before jumping into ${feat.name}`,
		);

	const id = uuid7AtMs(Date.now());
	// A feat named by its own id reads as a uuid; its heading is what a pilot knows it by.
	const label = uuidLike(feat.name) ? (feat.h1 ?? feat.name) : feat.name;
	const title = `${titleFromSlug(label.replaceAll(" ", "-"))} ${managedDiveName("", id).slice(1)}`;
	const at = new Date().toISOString().slice(0, 16);
	// Only the record's own line is worth keeping: its next step is this jump.
	const quiet: CommandIo = Object.assign(Object.create(io) as CommandIo, {
		log: (message: string) => {
			if (message.startsWith("Recorded ")) io.err(`jump: recorded ${message.slice(9)}`);
		},
	});
	recordDive(
		["--feat", featRefOf(feat), "--gist", `Free dive on ${label} at ${at}Z`, "--title", title],
		quiet,
		// jump reads every dive's brief; this one says there was no plan.
		{ brief: `An unplanned dive into ${label}: no brief was written.`, newId: id },
	);
	return id;
}
