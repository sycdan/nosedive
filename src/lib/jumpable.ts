import type { NosediveRc } from "./coreParsing.js";
import type { KbDoc } from "./kbDocs.js";
import { linkedDoc } from "./repoLinks.js";

const key = (doc: KbDoc): string => `${doc.home?.repoId ?? ""}:${doc.id}`;

/** The backlog memo `backlog:` names: where the walk for feats starts. */
function backlogRoot(rc: NosediveRc, kbDocs: KbDoc[]): KbDoc {
	if (!rc.backlog)
		throw new Error("jump needs a configured backlog memo, the root a feat is reached from");
	const root = kbDocs.find((doc) => doc.id === rc.backlog);
	if (!root) throw new Error(`bridge backlog memo not found: ${rc.backlog}`);
	return root;
}

/**
 * Whether `doc` can be jumped into as a feat: some link whose rel ends in
 * `.feat` reaches it on a walk from the backlog memo, across repos the way the
 * dive walk crosses them. Its kind does not enter into it, and the backlog
 * itself is where the walk starts, not something it reaches.
 */
export function isJumpable(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	doc: KbDoc,
	repoId = doc.home?.repoId,
): boolean {
	const byId = new Map(kbDocs.map((candidate) => [candidate.id, candidate]));
	const queue = [backlogRoot(rc, kbDocs)];
	const walked = new Set<string>();
	const reached = new Set<string>();
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (walked.has(key(current))) continue;
		walked.add(key(current));
		for (const link of current.links) {
			if (!link.rel?.endsWith(".feat")) continue;
			const target = linkedDoc(rc, current, link, byId);
			if (!target) continue;
			reached.add(key(target));
			queue.push(target);
		}
	}
	return reached.has(`${repoId ?? ""}:${doc.id}`);
}

export function assertJumpable(rc: NosediveRc, kbDocs: KbDoc[], doc: KbDoc): void {
	if (!doc.home && doc.id === rc.backlog)
		throw new Error(`${doc.name} is the backlog, not a feat; jump one of its feats`);
	if (isJumpable(rc, kbDocs, doc)) return;
	throw new Error(
		`${doc.name} is not a feat: nothing reaches it from the root through a .feat link; link it from a feat first`,
	);
}
