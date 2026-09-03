import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { resolveBridgeDocRef } from "../lib/diveScopes.js";
import { declaringGateDocs } from "../lib/gateDeclarations.js";
import { attachFailedGatesToDive, hydrateGateRepos, runGateSession } from "../lib/gateSession.js";
import { readWorkspaceDiveMarker } from "../lib/gitState.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { appendTimestampedSection } from "../lib/kbSections.js";
import {
	collectDiveGates,
	collectFeatGates,
	type GateRun,
	LandGate,
	renderGateReport,
	resolveGateScript,
} from "../lib/landGates.js";
import { describeDirtyGates, dirtyGates } from "../lib/gateFreshness.js";
import { recordDive } from "../lib/recordDive.js";
import { appendLinkToDoc, resolveFeatDoc } from "../lib/repoFeatScopes.js";

interface TestArgs {
	gateRefs: string[];
	full: boolean;
	viaRef?: string;
}

/**
 * `--full` is a flag where `test@1` spelled the same idea as the bare word
 * `land`. That word had to go: a gate rel qualifier names the command that runs
 * it, so `test` runs `test.gate` and there is no verb to pass. Once nothing
 * widens by naming another command, the widening is an option like any other.
 *
 * A positional argument is therefore a gate document reference. `land` now
 * reaches document resolution and is rejected clearly when it names no path.
 */
function parseTestArgs(args: string[]): TestArgs {
	const gateRefs: string[] = [];
	let full = false;
	let viaRef: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--full") {
			full = true;
			continue;
		}
		if (arg === "--via") {
			if (viaRef !== undefined) throw new Error("--via may be given only once");
			viaRef = args[index + 1];
			if (!viaRef || viaRef.startsWith("--"))
				throw new Error("--via requires a document reference");
			index += 1;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown test option: ${arg}`);
		gateRefs.push(arg);
	}
	if (viaRef !== undefined && gateRefs.length === 0) {
		throw new Error("--via requires at least one gate reference");
	}
	return { gateRefs, full, viaRef };
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(test, args);
}

async function test(args: string[], io: CommandIo): Promise<void> {
	const { gateRefs, full, viaRef } = parseTestArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("test requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	const dive =
		marker.id !== undefined
			? kbDocs.find((doc) => doc.id === marker.id && doc.kind === "dive")
			: undefined;
	const feat = dive?.featRef ? resolveFeatDoc(kbDocs, rc, dive.featRef) : undefined;

	/**
	 * No dive is a regression pass, not an error. `test@1` refused here because
	 * its selection roots were the dive and nothing else; sweeping the backlog
	 * gives the no-dive form something honest to mean, which is what a pilot
	 * wants between dives.
	 */
	const selected =
		gateRefs.length > 0
			? gateRefs.map((ref) => namedGate(ref, kbDocs, rc.bridgeDir, viaRef, dive))
			: dive
				? selectDiveGates(dive, kbDocs, rc, full)
				: selectBacklogGates(kbDocs, rc);

	if (selected.length === 0) {
		/**
		 * Zero gates is the one verdict a test command must never report as
		 * success: it would teach a pilot that green means checked when it means
		 * unchecked. The friction fix is naming what to try next, not calling it
		 * green.
		 */
		io.writeErr(
			dive
				? `test: this dive selects no test.gate gates. Add one, or run \`test --full\` to widen the search.\n`
				: `test: the backlog selects no test.gate gates. Add one before treating this regression pass as checked.\n`,
		);
		io.setExitCode(1);
		return;
	}

	// A notice, never a refusal: `test` is the loop a gate gets written in, and
	// the gate is uncommitted for most of it. `land` is where it has to be true.
	const stale = dirtyGates(rc.bridgeDir, selected);
	if (stale.length > 0) {
		io.writeErr(`test: uncommitted gate source; land will refuse until it is published
`);
		io.writeErr(`${describeDirtyGates(stale)}
`);
	}

	const { hydrated, reports } = hydrateGateRepos(selected, kbDocs, rc.bridgeDir, rc.workspaceDir);
	/** The resolved workspace is named before gates stream, including empty sets and pins that existing worktrees do not hold. */
	for (const report of reports) io.writeErr(report);
	const outcome = await runGateSession(
		selected,
		kbDocs,
		rc.bridgeDir,
		dive?.id ?? "",
		feat?.id,
		hydrated,
		io,
	);
	if (outcome.failed) {
		const claimed: GateRun[] = [];
		const unclaimed: GateRun[] = [];
		for (const gateRun of outcome.runs) {
			if (gateRun.status === 0 || gateRun.gate.flaky) continue;
			(claimedByActiveDive(gateRun.gate, dive, feat, kbDocs, rc) ? claimed : unclaimed).push(
				gateRun,
			);
		}
		if (dive) {
			const divePath = join(rc.bridgeDir, dive.relPath);
			appendTimestampedSection(divePath, renderGateReport(selected, outcome, dive), "Test report");
			attachFailedGatesToDive(divePath, dive.links, claimed);
		}
		mintUnclaimedFailures(unclaimed, kbDocs, rc, io);
	}
}

/**
 * The dive on deck answers for a failure its own feat declared, and for one
 * whose gate carries its own `scopes:` -- such a gate names no feat, so there
 * is no document to record work against but the dive already in hand.
 *
 * Everything else is unclaimed: another feat's gate reached by a wide walk, and
 * every blocking failure at all when no dive is on deck. Which selection form
 * found it does not enter into it. A gate is red and no dive owns it either way,
 * and a pilot who ran the command `record.gate` printed should not have to know
 * that the bare form is the one that hands them somewhere to start.
 */
function claimedByActiveDive(
	gate: LandGate,
	dive: KbDoc | undefined,
	feat: KbDoc | undefined,
	kbDocs: KbDoc[],
	rc: ReturnType<typeof readNosediveRc>,
): boolean {
	if (!dive) return false;
	const owner = owningFeat(gate.introducedBy, kbDocs, rc);
	return !owner || owner.id === feat?.id;
}

/** The feat a gate's declaring document belongs to, if it resolves to one. */
function owningFeat(
	declaredBy: KbDoc,
	kbDocs: KbDoc[],
	rc: ReturnType<typeof readNosediveRc>,
): KbDoc | undefined {
	if (declaredBy.kind === "feat") return declaredBy;
	if (!declaredBy.featRef) return undefined;
	try {
		const resolved = resolveFeatDoc(kbDocs, rc, declaredBy.featRef);
		return resolved.kind === "feat" ? resolved : undefined;
	} catch {
		// The failed run already owns the exit status; the caller explains why no work was minted.
		return undefined;
	}
}

/**
 * A blocking failure no dive claims is work nobody has started, so it becomes a
 * dive. The caller has already dropped the passes and the flaky runs. Reload
 * after recording because `recordDive` writes both docs and the next failure
 * must deduplicate against those writes too.
 */
function mintUnclaimedFailures(
	runs: GateRun[],
	initialDocs: KbDoc[],
	rc: ReturnType<typeof readNosediveRc>,
	io: CommandIo,
): void {
	let kbDocs = initialDocs;
	for (const run of runs) {
		if (
			kbDocs.some(
				(doc) => doc.kind === "dive" && doc.links.some((link) => link.id === run.gate.doc.id),
			)
		) {
			continue;
		}

		const declaredBy = run.gate.introducedBy;
		const feat = owningFeat(declaredBy, kbDocs, rc);
		if (!feat) {
			io.writeErr(
				`test: gate ${run.gate.doc.name || run.gate.doc.id} (${run.gate.doc.id}), declared by ${declaredBy.relPath}: a test.gate needs a feat in context to mint against.\n`,
			);
			continue;
		}

		const before = new Set(kbDocs.filter((doc) => doc.kind === "dive").map((doc) => doc.id));
		const brief = [
			`Gate: ${run.gate.doc.id}`,
			`Declared by: ${declaredBy.relPath}`,
			"",
			"stderr:",
			run.stderr || "(none)",
			"",
			"stdout:",
			run.stdout || "(none)",
		].join("\n");
		recordDive(
			[
				"--feat",
				feat.id,
				"--gist",
				`triage ${run.gate.doc.name || run.gate.doc.id} failure`,
				"--brief",
				brief,
			],
			io,
		);
		kbDocs = loadKbDocs(rc.kbDir!, rc.bridgeDir);
		const minted = kbDocs.find((doc) => doc.kind === "dive" && !before.has(doc.id));
		if (!minted) throw new Error(`test failed to find the dive minted for gate ${run.gate.doc.id}`);
		const mintedPath = join(rc.bridgeDir, minted.relPath);
		/** @see kb/1e62a79d-4e06-552d-be5a-4c59c85f86bf.md#red-to-green */
		appendLinkToDoc(join(rc.bridgeDir, minted.relPath), run.gate.doc.id, "land.gate");
		kbDocs = loadKbDocs(rc.kbDir!, rc.bridgeDir);
	}
}

/**
 * A gate carrying its own `scopes:` answers for itself, empty list included.
 * Otherwise the document that declared it does, which is why naming a gate has
 * to find that document rather than reading the gate's absent key as no repos.
 *
 * The active dive wins when it is one of the declaring documents. That is the
 * order every other selection path walks -- dive, then feat, then repo -- and
 * the red-to-green loop deliberately links the gate it mints work against as a
 * `land.gate` on that dive, so a gate under work is normally declared twice.
 * Refusing there would refuse the loop this command exists to run.
 *
 * `--via` narrows before any of that, because a pilot naming a root has said
 * which declaration they mean and should not be overruled by the dive they
 * happen to be on.
 */
function namedGate(
	ref: string,
	kbDocs: KbDoc[],
	bridgeDir: string,
	viaRef?: string,
	dive?: KbDoc,
): LandGate {
	const doc = resolveBridgeDocRef(bridgeDir, kbDocs, ref);
	let introducedBy = doc;
	if (!doc.hasScopes) {
		const via = viaRef ? resolveBridgeDocRef(bridgeDir, kbDocs, viaRef) : undefined;
		const reachable = via ? reachableDocs(via, kbDocs) : kbDocs;
		const declaring = declaringGateDocs(reachable, doc.id);
		const active = dive ? declaring.find((candidate) => candidate.id === dive.id) : undefined;
		if (active) return builtGate(doc, active, bridgeDir);
		if (declaring.length === 0) {
			const narrowed = via ? ` reachable from --via ${docLabel(via)}` : "";
			throw new Error(
				`gate ${docLabel(doc)} has no declaring document${narrowed}; ` +
					`declare it on a feat with \`nosedive record.gate ${doc.id} --feat <feat-ref>\`, ` +
					`or write \`scopes: []\` in ${doc.relPath} when it needs no repo`,
			);
		}
		if (declaring.length > 1) {
			throw new Error(
				`gate ${docLabel(doc)} has several declaring documents: ` +
					`${declaring.map(docLabel).join(", ")}; use \`--via <doc-ref>\` to pick one`,
			);
		}
		introducedBy = declaring[0]!;
	}
	return builtGate(doc, introducedBy, bridgeDir);
}

function builtGate(doc: KbDoc, introducedBy: KbDoc, bridgeDir: string): LandGate {
	return {
		doc,
		scriptPath: resolveGateScript(doc, bridgeDir),
		gateHeight: 0,
		flaky: false,
		introducedBy,
		shadowedBy: [],
	};
}

function reachableDocs(root: KbDoc, kbDocs: KbDoc[]): KbDoc[] {
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const seen = new Set<string>();
	const reachable: KbDoc[] = [];
	const walk = (doc: KbDoc): void => {
		if (seen.has(doc.id)) return;
		seen.add(doc.id);
		reachable.push(doc);
		for (const link of doc.links) {
			const target = byId.get(link.id);
			if (target) walk(target);
		}
	};
	walk(root);
	return reachable;
}

function docLabel(doc: KbDoc): string {
	return `${doc.relPath} (${doc.name || doc.id})`;
}

/**
 * `--full` selects from the same three roots `land` walks, but for `test.gate`
 * rather than `land.gate`. Repos declare only `land.gate` -- a repo cannot
 * regress without a feat in context -- so in practice they contribute nothing
 * here, and the widening is out through the feat.
 */
function selectDiveGates(
	dive: KbDoc,
	kbDocs: KbDoc[],
	rc: ReturnType<typeof readNosediveRc>,
	full: boolean,
): LandGate[] {
	if (!full) return collectDiveGates("test", dive, kbDocs, rc.bridgeDir);
	const feat = dive.featRef ? resolveFeatDoc(kbDocs, rc, dive.featRef) : undefined;
	const roots = [
		dive,
		...(feat ? [feat] : []),
		...dive.scopes
			.map((scope) => kbDocs.find((doc) => doc.id === scope.repoId))
			.filter((doc): doc is KbDoc => doc !== undefined),
	];
	return collectFeatGates("test", roots, kbDocs, rc.bridgeDir);
}

/**
 * The backlog memo is the widest root a level 2 bridge has, so walking it
 * reaches every feat and therefore every `test.gate` anyone declared. At level 3
 * this becomes the active ship's decks.
 */
function selectBacklogGates(kbDocs: KbDoc[], rc: ReturnType<typeof readNosediveRc>): LandGate[] {
	if (!rc.backlog) throw new Error("test requires a configured backlog memo id");
	const backlog = kbDocs.find((doc) => doc.id === rc.backlog);
	if (!backlog) throw new Error(`bridge backlog memo not found: ${rc.backlog}`);
	return collectFeatGates("test", [backlog], kbDocs, rc.bridgeDir);
}
