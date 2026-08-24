import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc } from "../lib/coreParsing.js";
import { attachFailedGatesToDive, hydrateGateRepos, runGateSession } from "../lib/gateSession.js";
import { readWorkspaceDiveMarker } from "../lib/gitState.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { appendTimestampedSection } from "../lib/kbSections.js";
import {
	collectDiveGates,
	collectFeatGates,
	LandGate,
	renderGateReport,
	resolveGateScript,
} from "../lib/landGates.js";
import { recordDive } from "../lib/recordDive.js";
import { appendLinkToDoc, resolveFeatDoc } from "../lib/repoFeatScopes.js";

interface TestArgs {
	gateRefs: string[];
	full: boolean;
}

/**
 * `--full` is a flag where `test@1` spelled the same idea as the bare word
 * `land`. That word had to go: a gate rel qualifier names the command that runs
 * it, so `test` runs `test.gate` and there is no verb to pass. Once nothing
 * widens by naming another command, the widening is an option like any other.
 *
 * A positional argument is therefore a gate uuid or a mistake, and `land` now
 * lands in the mistake branch by the same rule that catches any other stray
 * word.
 */
function parseTestArgs(args: string[]): TestArgs {
	const gateRefs: string[] = [];
	let full = false;
	for (const arg of args) {
		if (arg === "--full") {
			full = true;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown test option: ${arg}`);
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg)) {
			throw new Error(`unrecognised test argument: ${arg}`);
		}
		gateRefs.push(arg);
	}
	return { gateRefs, full };
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(test, args);
}

async function test(args: string[], io: CommandIo): Promise<void> {
	const { gateRefs, full } = parseTestArgs(args);
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
			? gateRefs.map((ref) => namedGate(ref, kbDocs, rc.bridgeDir))
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
	if (dive && outcome.failed) {
		const divePath = join(rc.bridgeDir, dive.relPath);
		appendTimestampedSection(divePath, renderGateReport(selected, outcome), "Test report");
		attachFailedGatesToDive(divePath, dive.links, outcome.runs);
	} else if (!dive && gateRefs.length === 0 && outcome.failed) {
		mintFailedBacklogGates(outcome.runs, kbDocs, rc, io);
	}
}

/**
 * A backlog sweep has no active dive to receive a blocking failure, so each
 * unowned failure becomes claimable work. Reload after recording because
 * `recordDive` writes both docs and the next failure must deduplicate against
 * those writes too.
 */
function mintFailedBacklogGates(
	runs: Awaited<ReturnType<typeof runGateSession>>["runs"],
	initialDocs: KbDoc[],
	rc: ReturnType<typeof readNosediveRc>,
	io: CommandIo,
): void {
	let kbDocs = initialDocs;
	for (const run of runs) {
		if (run.status === 0 || run.gate.flaky) continue;
		if (
			kbDocs.some(
				(doc) => doc.kind === "dive" && doc.links.some((link) => link.id === run.gate.doc.id),
			)
		) {
			continue;
		}

		const declaredBy = run.gate.introducedBy;
		let feat = declaredBy.kind === "feat" ? declaredBy : undefined;
		if (!feat && declaredBy.featRef) {
			try {
				const resolved = resolveFeatDoc(kbDocs, rc, declaredBy.featRef);
				if (resolved.kind === "feat") feat = resolved;
			} catch {
				// The failed run already owns the exit status; the message below explains why no work was minted.
			}
		}
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

function namedGate(id: string, kbDocs: KbDoc[], bridgeDir: string): LandGate {
	const doc = kbDocs.find((candidate) => candidate.id === id);
	if (!doc) throw new Error(`gate not found: ${id}`);
	return {
		doc,
		scriptPath: resolveGateScript(doc, bridgeDir),
		gateHeight: 0,
		flaky: false,
		introducedBy: doc,
		shadowedBy: [],
	};
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
