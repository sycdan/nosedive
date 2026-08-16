import { readNosediveRc } from "./coreParsing.js";
import { KbDoc, loadKbDocs } from "./kbDocs.js";

/**
 * The kb reader a gate is handed as `ctx.resolve`.
 *
 * Gates run as spawned children with cwd `bridgeRoot`, and a gate script cannot
 * import a nosedive lib for itself: under `npx -y nosedive@dev` the package sits
 * in an npx cache directory the bridge has no way to name. The gate runner can,
 * because nosedive knows where its own dist is, so this is imported there and
 * attached to the context after it is parsed.
 *
 * Read-only, and deliberately so. A gate that could write would be editing the
 * thing it was selected to verify, and a failed land would leave the kb in
 * whatever state the gate reached before it gave up.
 */
export function createGateResolver(bridgeRoot: string): (quid: string) => Promise<KbDoc> {
	/**
	 * Loaded once per child, which is once per gate. Within a single gate the kb
	 * cannot change -- the gate cannot write it -- so re-reading 400-odd files per
	 * lookup would buy nothing. Across gates it is still a live read: each child
	 * loads afresh, so two gates in one run can legitimately disagree if
	 * something changed between them. That is the point. A snapshot taken once
	 * for the whole run is the thing that goes stale and lies.
	 */
	let docs: KbDoc[] | undefined;

	return async (quid: string): Promise<KbDoc> => {
		if (!docs) {
			const rc = readNosediveRc(bridgeRoot);
			if (!rc.kbDir) throw new Error("ctx.resolve needs a bridge with a configured kb directory");
			docs = loadKbDocs(rc.kbDir, rc.bridgeDir);
		}
		const doc = docs.find((candidate) => candidate.id === quid);
		/**
		 * Missing is an error, never undefined. A gate that reads `ctx.resolve(id)`
		 * and gets nothing back will usually go on to pass, and a gate passing
		 * because a document was absent is the same failure `resolveGateScript`
		 * already refuses to allow: unchecked reported as checked.
		 */
		if (!doc) throw new Error(`ctx.resolve found no kb document: ${quid}`);
		return doc;
	};
}
