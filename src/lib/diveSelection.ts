import { NosediveRc, uuidLike } from "./coreParsing.js";
import {
	DiveLink,
	ListedDive,
	diveDiver,
	diveRole,
	diveTags,
	listedDive,
	walkDeckDives,
} from "./diveListing.js";
import { KbDoc } from "./kbDocs.js";
import { readGitAuthorIdentity } from "./gitProcess.js";

export interface PilotDiveSelection {
	/** Dives this pilot may claim: unheld, or already held by this pilot. */
	eligible: ListedDive[];
	/** Dives the walk reached that some other pilot holds. */
	held: ListedDive[];
	/**
	 * Why the selection is empty, when it is empty because the backlog memo could
	 * not be read. Every dive here is reached through that memo, so a broken one
	 * must not be reported as "no work to pick up".
	 */
	warnings: string[];
}

/**
 * A finished dive is finished whatever its doc still claims to be. `land` and
 * `bail` rewrite `kind: dive` to `kind: memo`, and the walk already drops a
 * non-dive, so this is a second lock on the same door -- one that holds even
 * for a doc those commands never touched.
 */
const FINISHED_DIVE_ROLES = new Set(["bailed", "landed"]);

/**
 * The same source `record.dive` claims a dive with, so what preflight offers
 * and what a claim writes cannot disagree. An unset `user.email` reads as no
 * pilot at all, which leaves every claimed dive held by someone else: a bridge
 * that cannot say who is flying has no standing to take work off anyone.
 */
function pilotEmail(rc: NosediveRc): string | undefined {
	const email = readGitAuthorIdentity(rc.bridgeDir).email.trim();
	return email || undefined;
}

function selectable(link: DiveLink, deckId: string): boolean {
	// A free dive is linked directly from the backlog deck, so it is not a feat
	// walk result and should stay awkward to pick up until it pays for a real
	// owner. The backlog tree is carried by rel semantics, not doc kind, so a
	// non-feat doc may still own the dive when it sits in the feat walk.
	if (!link.owner || link.owner.id === deckId) return false;
	const role = diveRole(link.rel);
	return !role || !FINISHED_DIVE_ROLES.has(role);
}

/**
 * Which dives this pilot can pick up, and which are spoken for. The one answer
 * to that question: preflight prints both buckets and `jump` needs the first,
 * and two implementations of "may I take this" would eventually offer a pilot
 * a dive the claim then refuses.
 */
export function selectPilotDives(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	localOnlyIds: ReadonlySet<string>,
): PilotDiveSelection {
	const backlogId = rc.backlog;
	if (!backlogId) return { eligible: [], held: [], warnings: ["no backlog memo is configured"] };
	if (!uuidLike(backlogId)) {
		return {
			eligible: [],
			held: [],
			warnings: [`listing dives requires a UUID-shaped backlog memo id: ${backlogId}`],
		};
	}

	const deck = kbDocs.find((doc) => doc.id === backlogId);
	if (!deck) {
		return { eligible: [], held: [], warnings: [`bridge backlog memo not found: ${backlogId}`] };
	}

	const pilot = pilotEmail(rc);
	const eligible: ListedDive[] = [];
	const held: ListedDive[] = [];
	for (const link of walkDeckDives(deck, kbDocs)) {
		if (!selectable(link, deck.id)) continue;
		const { dive, rel, owner } = link;
		const diver = diveDiver(dive);
		const bucket = !diver || (pilot !== undefined && diver === pilot) ? eligible : held;
		bucket.push(listedDive(dive, rel, diveTags(dive, localOnlyIds), owner));
	}

	return { eligible, held, warnings: [] };
}

export interface PreflightDivesResult {
	available: ListedDive[];
	held: ListedDive[];
	warnings: string[];
}

/**
 * The session-start dive list, which is the selection under preflight's own
 * words for it. Preflight says "Available" because it is talking to the pilot
 * about what they can take; the rule itself has no opinion about the heading.
 */
export function collectPreflightDives(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	localOnlyIds: ReadonlySet<string>,
): PreflightDivesResult {
	const { eligible, held, warnings } = selectPilotDives(rc, kbDocs, localOnlyIds);
	return { available: eligible, held, warnings };
}
