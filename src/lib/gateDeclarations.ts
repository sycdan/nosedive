import type { KbDoc } from "./kbDocs.js";

/** Every document whose `.gate` link names this gate. */
export function declaringGateDocs(kbDocs: KbDoc[], gateId: string): KbDoc[] {
	return kbDocs.filter((doc) =>
		doc.links.some((link) => link.id === gateId && (link.rel?.endsWith(".gate") ?? false)),
	);
}
