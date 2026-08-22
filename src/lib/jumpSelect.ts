import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

import { CommandIo } from "./bridgeSetupIo.js";
import { NosediveRc, formatPath, splitMarkdownFrontmatter, stringifyYaml } from "./coreParsing.js";
import { appendJumpableDives, diveDiver, localOnlyKbDocIds } from "./diveListing.js";
import { resolveBridgeDocRef } from "./diveScopes.js";
import { PilotDiveSelection, selectPilotDives } from "./diveSelection.js";
import { readPilotIdentity } from "./gitState.js";
import { KbDoc } from "./kbDocs.js";
import { nosediveInvocation } from "./packageBacklog.js";
import { writeFileAtomic } from "./renderPlan.js";
import { parseRepoMarkerStrict } from "./repoWorkspaceCore.js";

/**
 * The dive the workspace has on deck, or nothing. Lives here rather than in
 * `recordDive.ts` because `jump` now asks the same question, and two readings
 * of one marker would eventually disagree about what "on deck" means.
 */
export function activeDive(kbDocs: KbDoc[], workspaceDir: string): KbDoc | undefined {
	const markerPath = join(workspaceDir, ".nosedive-ref");
	if (!existsSync(markerPath)) return undefined;
	const marker = parseRepoMarkerStrict(markerPath);
	const doc = kbDocs.find((candidate) => candidate.id === marker.id);
	if (!doc || doc.kind !== "dive")
		throw new Error(`active marker names no kind: dive doc: ${formatPath(markerPath)}`);
	return doc;
}

/**
 * Whether claiming `target` should put it on deck, refusing when the workspace
 * is already flying something else. The two refusals are deliberately
 * different: a pilot holding their own other dive has to land or hand it off,
 * while a workspace holding someone else's is a checkout that was never theirs
 * to reuse.
 */
export function ensureActivation(
	target: KbDoc | { id: string },
	diver: string | undefined,
	pilotEmail: string,
	active: KbDoc | undefined,
): boolean {
	if (!diver || diver !== pilotEmail) return false;
	if (!active || active.id === target.id) return true;
	if (active.metaScalars.diver === diver) {
		throw new Error(`pilot already has active dive ${active.id}; land or hand it off first`);
	}
	throw new Error(`workspace already has active dive ${active.id}`);
}

export interface JumpSelection {
	dive: KbDoc;
	/** Whether this run is picking the dive up, rather than re-jumping one already on deck. */
	claim: boolean;
	pilotEmail: string;
}

/** The dives this pilot could jump, grouped by feat with the path to jump them by. */
function listEligible(io: CommandIo, selection: PilotDiveSelection): void {
	const lines: string[] = [];
	appendJumpableDives(lines, selection.eligible);
	for (const line of lines) io.err(line);
}

/**
 * Which dive `jump` should work on, given an optional ref and whatever the
 * workspace holds. Returns nothing when the run has been refused -- the
 * refusal is on stderr and the exit code is already set, because a refusal
 * whose whole value is a list of alternatives reads better unprefixed than as
 * a one-line thrown error.
 */
export function selectJumpDive(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	ref: string | undefined,
	io: CommandIo,
): JumpSelection | undefined {
	const held = activeDive(kbDocs, rc.workspaceDir!);
	const pilotEmail = readPilotIdentity(rc.bridgeDir).email.trim();
	if (ref === undefined && held) {
		if (!pilotEmail) throw new Error("jump requires git config user.email in the bridge");
		const diver = diveDiver(held);
		if (diver && diver !== pilotEmail) {
			throw new Error(
				`dive ${held.id} is held by ${diver}; take it over with \`${nosediveInvocation()} record.dive --ref ${held.id} --takeover\``,
			);
		}
		return { dive: held, claim: diver !== pilotEmail, pilotEmail };
	}

	const selection = selectPilotDives(rc, kbDocs, localOnlyKbDocIds(rc.bridgeDir, rc.kbDir!));
	for (const warning of selection.warnings) io.err(warning);
	const eligible = new Set(selection.eligible.map((dive) => dive.id));

	if (ref === undefined) {
		// Nothing on deck and nothing to offer: the standing explanation of an
		// empty deck is the honest thing to point at, but say why the list is
		// missing first -- an unexplained absence reads as a broken command.
		if (eligible.size === 0) {
			io.err(
				`nose: no dive is available to pick up; create one with \`${nosediveInvocation()} record.dive\``,
			);
			io.setExitCode(1);
			return undefined;
		}
		// One dive on deck is not a choice, and offering it as one is how a new
		// pilot's first `jump` becomes a menu of length one. No holder check is
		// needed here: `selectPilotDives` has already put anything another pilot
		// holds in `held`, so nothing in `eligible` can be theirs.
		if (eligible.size === 1) {
			const only = selection.eligible[0]!;
			const dive = kbDocs.find((candidate) => candidate.id === only.id);
			if (!dive) throw new Error(`selected dive not found in kb: ${only.id}`);
			if (!pilotEmail) throw new Error("jump requires git config user.email in the bridge");
			const diver = diveDiver(dive);
			ensureActivation(dive, pilotEmail, pilotEmail, held);
			// Named, because a pilot who did not choose still has to know what they
			// are on before the brief scrolls past.
			io.log(`jump: picked up the only dive on deck -- ${dive.relPath}: ${dive.gist}`);
			return { dive, claim: diver !== pilotEmail, pilotEmail };
		}
		io.err(
			`nose: no dive is on deck; pick one up with \`${nosediveInvocation()} jump <dive-doc-path>\`. Options:`,
		);
		listEligible(io, selection);
		io.setExitCode(1);
		return undefined;
	}

	const dive = resolveBridgeDocRef(rc.bridgeDir, kbDocs, ref);
	if (dive.kind !== "dive")
		throw new Error(`<dive-ref> does not resolve to a kind: dive doc: ${ref}`);
	if (!pilotEmail) throw new Error("jump <dive-ref> requires git config user.email in the bridge");
	const diver = diveDiver(dive);
	if (diver && diver !== pilotEmail) {
		throw new Error(
			`dive ${dive.id} is held by ${diver}; take it over with \`${nosediveInvocation()} record.dive --ref ${dive.id} --takeover\``,
		);
	}
	// Checked even when the dive is the one already on deck: a dive that stopped
	// being eligible for some reason other than its holder is not silently
	// accepted. A foreign holder was handled above so that refusal can name the
	// explicit takeover rather than burying it in the general alternatives list.
	if (!eligible.has(dive.id)) {
		io.err(`${dive.id} is not a dive you can pick up; these are:`);
		listEligible(io, selection);
		io.setExitCode(1);
		return undefined;
	}
	ensureActivation(dive, pilotEmail, pilotEmail, held);
	return { dive, claim: diver !== pilotEmail, pilotEmail };
}

/**
 * Records the claim, and says who to print. The two are one call because the
 * name only ever comes from the local git config: whoever the doc ends up
 * naming is exactly who this run is entitled to render in full.
 */
export function claimAndLabel(rc: NosediveRc, dive: KbDoc, selection: JumpSelection): string {
	if (selection.claim) setDiveDiver(dive.path, selection.pilotEmail);
	const diver = selection.claim ? selection.pilotEmail : diveDiver(dive);
	if (!diver) return rc.pilotName?.trim() || "an unnamed diver";
	// Git's author form, and only for the pilot themselves. `meta.diver` is an
	// email because that is what compares across checkouts; a name is display
	// only, and this checkout's git config can vouch for exactly one person's.
	const identity = readPilotIdentity(rc.bridgeDir);
	const name = identity.name.trim();
	return name && identity.email.trim() === diver ? `${name} <${diver}>` : diver;
}

function setDiveDiver(divePath: string, email: string): void {
	const text = readFileSync(divePath, "utf8");
	const block = splitMarkdownFrontmatter(text, formatPath(divePath));
	const doc = parseDocument(block.yaml);
	if (doc.errors.length > 0) {
		throw new Error(`invalid YAML in frontmatter in ${formatPath(divePath)}`);
	}
	doc.setIn(["meta", "diver"], email);
	// `meta.packer` records who put the dive down last, so it is only true of a
	// dive nobody holds. Picking it up ends that.
	doc.deleteIn(["meta", "packer"]);
	writeFileAtomic(divePath, `---\n${stringifyYaml(doc).trimEnd()}\n---\n${block.body}`);
}

/** `jump [<dive-ref>]` -- one optional positional, and no flags to confuse it with. */
export function parseJumpArgs(args: string[]): string | undefined {
	if (args.length > 1) throw new Error(`jump takes at most one <dive-ref>: ${args.join(" ")}`);
	const ref = args[0];
	if (ref !== undefined && ref.startsWith("-")) throw new Error(`jump takes no options: ${ref}`);
	return ref;
}
