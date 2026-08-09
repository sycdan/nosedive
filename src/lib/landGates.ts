import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { formatPath, resolveFrom, toPosixPath } from "./coreParsing.js";
import { commandForSpawn, spawnOutputText } from "./gitState.js";
import { KbDoc } from "./kbDocs.js";
import { unsafeLinkPath } from "./proveCore.js";
import { cleanGitEnv } from "./renderPlan.js";

/** Kinds a `land-gated-by` edge may point at. Anything else is a mis-linked doc, not a gate. */
export const GATE_KINDS = new Set(["assertion", "test", "gate", "check", "proof", "prover"]);
const GATE_REL = "land-gated-by";

export const DEFAULT_CLOCK = "30";

export interface LandGate {
	doc: KbDoc;
	scriptPath: string;
	gateHeight: number;
	flaky: boolean;
	/** Doc whose link claimed this gate; its attributes are the ones in force. */
	introducedBy: KbDoc;
	/** Docs whose later duplicate edges lost to `introducedBy`, so first-seen-wins is auditable. */
	shadowedBy: KbDoc[];
}

export interface GateRun {
	gate: LandGate;
	status: number;
	stderr: string;
	stdout: string;
	startedAt: string;
	endedAt: string;
	elapsedMs: number;
}

export interface GateOutcome {
	runs: GateRun[];
	/** Gates the budget ran out before, in the order they would have run. */
	skipped: LandGate[];
	budgetExhausted: boolean;
	/** Gate whose run pushed elapsed time past the budget, if any. */
	overran?: LandGate;
	failed: boolean;
	elapsedMs: number;
}

/**
 * A bare integer is seconds. Anything richer (`5m`, `1h30m`) is rejected rather
 * than guessed at, leaving the syntax free to grow later.
 */
export function parseClockSeconds(raw: string): number {
	if (!/^\d+$/.test(raw.trim())) throw new Error(`unsupported clock: ${raw}`);
	return Number.parseInt(raw.trim(), 10);
}

function gateAttrInt(value: string | undefined, label: string): number {
	if (value === undefined) return 0;
	if (!/^-?\d+$/.test(value.trim())) {
		throw new Error(`${label} must be an integer, got: ${value}`);
	}
	return Number.parseInt(value.trim(), 10);
}

function gateAttrBool(value: string | undefined, label: string): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	throw new Error(`${label} must be true or false, got: ${value}`);
}

/**
 * `meta.test-script` is a bridge-relative path, resolved the same way patch and
 * prover artifacts are: no absolute paths, no traversal, no URIs. A gate that
 * cannot produce a runnable script is a hard failure -- silently skipping one
 * would turn a broken gate into a passing land.
 */
export function resolveGateScript(doc: KbDoc, bridgeDir: string): string {
	const label = `gate ${doc.id} (${doc.relPath}) meta.test-script`;
	const rel = doc.metaScalars["test-script"];
	if (!rel) {
		throw new Error(
			`${label} is missing; add one naming the script that proves this gate, e.g. kb/artifacts/<uuid>.mjs`,
		);
	}
	if (isAbsolute(rel) || unsafeLinkPath(rel)) {
		throw new Error(`${label} must be a bridge-relative path without traversal: ${rel}`);
	}
	const path = resolveFrom(bridgeDir, rel);
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`${label} does not resolve to a file: ${formatPath(path)} -- create it`);
	}
	return path;
}

/**
 * Walks every link reachable from the roots, not just gate edges: a gate may be
 * declared by an effort, a repo, or anything else in the dive's ancestry.
 * First-seen wins for a gate's attributes, so pass roots closest-first -- the
 * dive, then its effort, then its scoped repos, which reach the dive through
 * frontmatter rather than links. Later edges are kept only so the report can
 * name them.
 */
export function collectLandGates(roots: KbDoc[], kbDocs: KbDoc[], bridgeDir: string): LandGate[] {
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const claimed = new Map<string, LandGate>();
	const visited = new Set<string>();
	const order: string[] = [];

	const walk = (doc: KbDoc): void => {
		if (visited.has(doc.id)) return;
		visited.add(doc.id);

		for (const link of doc.links) {
			const target = byId.get(link.id);
			if (link.rel === GATE_REL) {
				if (!target) {
					throw new Error(`${GATE_REL} link in ${doc.relPath} names an unknown doc: ${link.id}`);
				}
				const existing = claimed.get(target.id);
				if (existing) {
					existing.shadowedBy.push(doc);
				} else {
					if (!GATE_KINDS.has(target.kind)) {
						throw new Error(
							`${GATE_REL} link in ${doc.relPath} points at kind: ${target.kind} (${target.relPath}); expected one of ${[...GATE_KINDS].join("|")}`,
						);
					}
					const label = `${GATE_REL} link to ${target.id} in ${doc.relPath}`;
					claimed.set(target.id, {
						doc: target,
						scriptPath: resolveGateScript(target, bridgeDir),
						gateHeight: gateAttrInt(link.attrs["gate-height"], `${label}: gate-height`),
						flaky: gateAttrBool(link.attrs["test-is-flaky"], `${label}: test-is-flaky`),
						introducedBy: doc,
						shadowedBy: [],
					});
					order.push(target.id);
				}
			}
			if (target) walk(target);
		}
	};

	for (const root of roots) walk(root);

	// Tallest first; equal heights keep the order they were discovered in.
	return order
		.map((id) => claimed.get(id)!)
		.map((gate, index) => ({ gate, index }))
		.sort((a, b) => b.gate.gateHeight - a.gate.gateHeight || a.index - b.index)
		.map((entry) => entry.gate);
}

export interface GateRepoContext {
	/** Bridge-relative path of the hydrated worktree, e.g. `workspace/nosedive`. */
	root: string;
}

/** Handed to a gate's `run(ctx)`. Repos are keyed by kb `name`, never by uuid. */
export interface GateContext {
	bridgeRoot: string;
	diveId: string;
	repos: Record<string, GateRepoContext>;
}

/** Builds the stable, human-readable repo map passed to gate scripts. */
export function gateRepoContext(
	hydrated: { repoId: string; path: string }[],
	kbDocs: KbDoc[],
	bridgeDir: string,
): Record<string, GateRepoContext> {
	const repos: Record<string, GateRepoContext> = {};
	for (const entry of hydrated) {
		const doc = kbDocs.find((candidate) => candidate.id === entry.repoId);
		if (!doc?.name) continue;
		repos[doc.name] = { root: toPosixPath(relative(bridgeDir, entry.path)) };
	}
	return repos;
}

/**
 * Gates always run from the bridge and resolve repos themselves through
 * `ctx.repos`. Anchoring a gate to one worktree would only hold while it
 * happened to scope one repo, and a gate that grows a second scope must not
 * change where it runs.
 *
 * Spawned rather than imported, so a gate calling `process.exit` or crashing
 * takes down its own process and not the land.
 */
const GATE_RUNNER = `import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(process.env.NOSEDIVE_GATE_MODULE).href);
if (typeof mod.run !== "function") {
	console.error("gate module must export run(ctx)");
	process.exit(1);
}
const outcome = await mod.run(JSON.parse(process.env.NOSEDIVE_GATE_CONTEXT));
process.exit(outcome === false ? 1 : 0);
`;

function writeGateRunner(): string {
	const dir = mkdtempSync(join(tmpdir(), "nosedive-gate-"));
	const path = join(dir, "run-gate.mjs");
	writeFileSync(path, GATE_RUNNER);
	return path;
}

/**
 * Sequential by design: gates share the hydrated worktrees, so two at once
 * would fight over the same build outputs and index.
 *
 * The budget is checked before every gate, the first included, and never
 * interrupts one that is already running -- a gate is left to finish (or to be
 * killed by hand) rather than being cut off half way and reported as a failure
 * it did not commit.
 */
export function runLandGates(
	gates: LandGate[],
	options: { clockSeconds: number; context: GateContext },
): GateOutcome {
	const runs: GateRun[] = [];
	const skipped: LandGate[] = [];
	const budgetMs = options.clockSeconds * 1000;
	const started = Date.now();
	let budgetExhausted = false;
	let overran: LandGate | undefined;
	const runnerPath = gates.length > 0 ? writeGateRunner() : undefined;
	const serializedContext = JSON.stringify(options.context);

	for (const gate of gates) {
		const elapsed = Date.now() - started;
		if (elapsed >= budgetMs) {
			budgetExhausted = true;
			skipped.push(gate);
			continue;
		}

		const startedAt = new Date();
		const spawn = commandForSpawn("node", [runnerPath!]);
		const result = spawnSync(spawn.command, spawn.args, {
			cwd: options.context.bridgeRoot,
			encoding: "utf8",
			env: {
				...cleanGitEnv(),
				NOSEDIVE_GATE_MODULE: gate.scriptPath,
				NOSEDIVE_GATE_CONTEXT: serializedContext,
			},
		});
		const endedAt = new Date();
		runs.push({
			gate,
			status: result.status ?? 1,
			stderr: spawnOutputText(result.stderr),
			stdout: spawnOutputText(result.stdout),
			startedAt: startedAt.toISOString(),
			endedAt: endedAt.toISOString(),
			elapsedMs: endedAt.getTime() - startedAt.getTime(),
		});
		if (!overran && Date.now() - started >= budgetMs) overran = gate;
	}

	const failed = budgetExhausted || runs.some((run) => run.status !== 0 && !run.gate.flaky);
	return {
		runs,
		skipped,
		budgetExhausted,
		overran,
		failed,
		elapsedMs: Date.now() - started,
	};
}

function gateLabel(gate: LandGate): string {
	return `${gate.doc.name || gate.doc.id} (${gate.doc.id})`;
}

/** Written into the dive so the next `jump` hands the whole picture to the next agent. */
export function renderGateReport(
	gates: LandGate[],
	outcome: GateOutcome,
	clockSeconds: number,
): string {
	const lines: string[] = [];
	lines.push(`Clock: ${clockSeconds}s budget, ${(outcome.elapsedMs / 1000).toFixed(1)}s elapsed.`);
	if (outcome.budgetExhausted) lines.push("Budget exhausted before every gate ran.");
	if (outcome.overran) lines.push(`Overran the budget: ${gateLabel(outcome.overran)}.`);
	lines.push("");

	lines.push("### Gates");
	lines.push("");
	if (gates.length === 0) lines.push("- (none declared)");
	for (const gate of gates) {
		const run = outcome.runs.find((entry) => entry.gate === gate);
		const verdict = !run
			? "never ran"
			: run.status === 0
				? "passed"
				: gate.flaky
					? `failed (exit ${run.status}) -- flaky, not blocking`
					: `FAILED (exit ${run.status})`;
		lines.push(`- ${gateLabel(gate)}: ${verdict}`);
		lines.push(`  - script: ${gate.scriptPath}`);
		lines.push(`  - gate-height: ${gate.gateHeight}, test-is-flaky: ${gate.flaky}`);
		lines.push(`  - declared by: ${gate.introducedBy.relPath}`);
		if (gate.shadowedBy.length > 0) {
			lines.push(
				`  - also linked by (attributes ignored, first-seen wins): ${gate.shadowedBy
					.map((doc) => doc.relPath)
					.join(", ")}`,
			);
		}
		if (run) {
			lines.push(`  - ran: ${run.startedAt} -> ${run.endedAt} (${run.elapsedMs}ms)`);
			const stderr = run.stderr.trim();
			if (stderr) {
				lines.push("  - stderr:");
				lines.push("");
				lines.push("```");
				lines.push(stderr);
				lines.push("```");
			}
		}
	}
	return lines.join("\n");
}
