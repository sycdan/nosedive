import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { formatPath, resolveFrom, toPosixPath } from "./coreParsing.js";
import { commandForSpawn } from "./gitState.js";
import { KbDoc } from "./kbDocs.js";
import { unsafeLinkPath } from "./proveCore.js";
import { cleanGitEnv } from "./gitProcess.js";

const GATE_VERBS = new Set(["land", "test", "drop", "lift"]);
/**
 * The pre-`land.gate` spelling. Named in full, deliberately: a bridge being
 * migrated is searched for this string, and the refusal below is the one place
 * that can tell someone what to rename. Hiding it to satisfy a "no source file
 * contains the old rel" check would make the migration path ungreppable.
 */
const LEGACY_GATE_REL = "land-gated-by";

function gateRel(verb: string): string {
	if (!GATE_VERBS.has(verb)) throw new Error(`unknown gate verb: ${verb}`);
	return `${verb}.gate`;
}

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
	failed: boolean;
	elapsedMs: number;
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
 * declared by a feat, a repo, or anything else in the dive's ancestry.
 * First-seen wins for a gate's attributes, so pass roots closest-first -- the
 * dive, then its feat, then its scoped repos, which reach the dive through
 * frontmatter rather than links. Later edges are kept only so the report can
 * name them.
 */
export function collectLandGates(
	verb: string,
	roots: KbDoc[],
	kbDocs: KbDoc[],
	bridgeDir: string,
): LandGate[] {
	const GATE_REL = gateRel(verb);
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const claimed = new Map<string, LandGate>();
	const visited = new Set<string>();
	const order: string[] = [];

	const walk = (doc: KbDoc): void => {
		if (visited.has(doc.id)) return;
		visited.add(doc.id);

		for (const link of doc.links) {
			const target = byId.get(link.id);
			if (link.rel === LEGACY_GATE_REL) {
				throw new Error(
					`${LEGACY_GATE_REL} link in ${doc.relPath} is obsolete; rename it to ${GATE_REL}`,
				);
			}
			if (link.rel === GATE_REL) {
				if (!target) {
					throw new Error(`${GATE_REL} link in ${doc.relPath} names an unknown doc: ${link.id}`);
				}
				const existing = claimed.get(target.id);
				if (existing) {
					existing.shadowedBy.push(doc);
				} else {
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

/**
 * The gates one document claims directly, without following anything else it
 * links. This is what `test` selects with no arguments: the dive's own gates,
 * not everything its feat and repos reach.
 *
 * The distinction is the point of the command. `land` walks wide because it is
 * the trust boundary and must run whatever guards the work. A pilot mid-dive
 * wants the checks for what they are changing, and wants them now.
 *
 * `gate-height` is read where present but nothing is reordered: height exists
 * to sequence a land, and a dive-sized set is small enough that discovery order
 * is the honest order. A dive gate needs no height.
 *
 * Gates that a gate itself depends on would be added here too, once
 * `depends-on.gate` exists -- it does not yet, so there is nothing transitive
 * to collect. See gate-ordering.
 */
export function collectDiveGates(
	verb: string,
	root: KbDoc,
	kbDocs: KbDoc[],
	bridgeDir: string,
): LandGate[] {
	const GATE_REL = gateRel(verb);
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const gates: LandGate[] = [];
	const seen = new Set<string>();

	for (const link of root.links) {
		if (link.rel === LEGACY_GATE_REL) {
			throw new Error(
				`${LEGACY_GATE_REL} link in ${root.relPath} is obsolete; rename it to ${GATE_REL}`,
			);
		}
		if (link.rel !== GATE_REL) continue;
		const target = byId.get(link.id);
		if (!target) {
			throw new Error(`${GATE_REL} link in ${root.relPath} names an unknown doc: ${link.id}`);
		}
		if (seen.has(target.id)) continue;
		seen.add(target.id);
		const label = `${GATE_REL} link to ${target.id} in ${root.relPath}`;
		gates.push({
			doc: target,
			scriptPath: resolveGateScript(target, bridgeDir),
			gateHeight: gateAttrInt(link.attrs["gate-height"], `${label}: gate-height`),
			flaky: gateAttrBool(link.attrs["test-is-flaky"], `${label}: test-is-flaky`),
			introducedBy: root,
			shadowedBy: [],
		});
	}
	return gates;
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
const GATE_RUNNER = `import { writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const mod = await import(pathToFileURL(process.env.NOSEDIVE_GATE_MODULE).href);
if (typeof mod.run !== "function") {
	console.error("gate module must export run(ctx)");
	process.exit(1);
}
const outcome = await mod.run(JSON.parse(process.env.NOSEDIVE_GATE_CONTEXT));
if (outcome === false) process.exitCode = 1;

// Draining instead of exiting here is what lets a node:test harness the gate
// module registered report at all -- exiting on the spot passed such a gate in
// silence however many of its tests failed. A gate that leaves a handle open
// would then hang the land, so the drain is bounded by silence rather than by
// elapsed time: a suite slower than any number we could pick is not a runaway,
// and a wall-clock budget would make a gate's verdict depend on how fast the
// machine is. Every byte the gate writes rearms the clock, so a gate still
// talking is never cut off. A gate that goes quiet for longer than the limit
// mid-run is the case this cannot tell from a hang; per-test timeouts are the
// right tool there, and the forced exit says on stderr why it fired.
const idleMs = Number(process.env.NOSEDIVE_GATE_IDLE_MS || 30000);
let idle;
const rearm = () => {
	clearTimeout(idle);
	// writeSync, not console.error: it bypasses the wrapper below so the notice
	// cannot rearm the clock it is reporting on, and it survives process.exit.
	idle = setTimeout(() => {
		writeSync(2, "gate produced no output for " + idleMs + "ms; forcing exit\\n");
		process.exit(1);
	}, idleMs);
	idle.unref();
};
for (const stream of [process.stdout, process.stderr]) {
	const write = stream.write.bind(stream);
	stream.write = (...args) => {
		rearm();
		return write(...args);
	};
}
rearm();
`;

function writeGateRunner(): string {
	const dir = mkdtempSync(join(tmpdir(), "nosedive-gate-"));
	const path = join(dir, "gate-runner.mjs");
	writeFileSync(path, GATE_RUNNER);
	return path;
}

/**
 * Where a gate's output goes while it is still running. The text is captured
 * for `renderGateReport` either way; a sink only decides whether a human also
 * sees it live. Callers pass their command's io rather than writing to the
 * process directly, so a gate's chatter obeys the same routing as everything
 * else the command says.
 */
export interface GateOutputSink {
	out(text: string): void;
	err(text: string): void;
}

/**
 * Spawned async rather than with `spawnSync`, which cannot both inherit and
 * capture: the report needs the text and the pilot needs it before the gate
 * ends. Every chunk is therefore appended and forwarded.
 */
function runGateChild(
	runnerPath: string,
	gate: LandGate,
	context: GateContext,
	serializedContext: string,
	sink?: GateOutputSink,
): Promise<{ status: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const command = commandForSpawn("node", [runnerPath]);
		const child = spawn(command.command, command.args, {
			cwd: context.bridgeRoot,
			env: {
				...cleanGitEnv(),
				NOSEDIVE_GATE_MODULE: gate.scriptPath,
				NOSEDIVE_GATE_CONTEXT: serializedContext,
			},
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (status: number): void => {
			if (settled) return;
			settled = true;
			resolve({ status, stdout, stderr });
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			sink?.out(chunk);
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
			sink?.err(chunk);
		});
		// A runner that cannot start is a failed gate, not a crashed command.
		child.on("error", (error: Error) => {
			const message = `gate could not start: ${error.message}\n`;
			stderr += message;
			sink?.err(message);
			settle(1);
		});
		child.on("close", (code) => settle(code ?? 1));
	});
}

/**
 * Sequential by design: gates share the hydrated worktrees, so two at once
 * would fight over the same build outputs and index. Being sequential is also
 * what lets output stream unprefixed -- only one gate can be talking.
 *
 * Every selected gate runs. There is no time budget: a stopwatch could only
 * drop whichever gates happened to be last, which makes coverage a property of
 * how fast the machine is, and it never protected against a runaway gate
 * anyway -- the budget was checked between gates and never interrupted one.
 */
export async function runLandGates(
	gates: LandGate[],
	options: { context: GateContext; sink?: GateOutputSink },
): Promise<GateOutcome> {
	const runs: GateRun[] = [];
	const started = Date.now();
	const runnerPath = gates.length > 0 ? writeGateRunner() : undefined;
	const serializedContext = JSON.stringify(options.context);

	// A header says which gate is talking. With one gate there is nothing to
	// disambiguate, so `test <gate>` stays as quiet as the gate itself.
	const headers = options.sink !== undefined && gates.length > 1;

	for (const gate of gates) {
		const startedAt = new Date();
		if (headers) options.sink?.err(`\n--- ${gateLabel(gate)} ---\n`);
		const result = await runGateChild(
			runnerPath!,
			gate,
			options.context,
			serializedContext,
			options.sink,
		);
		const endedAt = new Date();
		runs.push({
			gate,
			status: result.status,
			stderr: result.stderr,
			stdout: result.stdout,
			startedAt: startedAt.toISOString(),
			endedAt: endedAt.toISOString(),
			elapsedMs: endedAt.getTime() - startedAt.getTime(),
		});
		if (headers) {
			options.sink?.err(
				`--- ${gateLabel(gate)}: ${result.status === 0 ? "passed" : `FAILED (exit ${result.status})`} in ${endedAt.getTime() - startedAt.getTime()}ms ---\n`,
			);
		}
	}

	const failed = runs.some((run) => run.status !== 0 && !run.gate.flaky);
	return {
		runs,
		failed,
		elapsedMs: Date.now() - started,
	};
}

function gateLabel(gate: LandGate): string {
	return `${gate.doc.name || gate.doc.id} (${gate.doc.id})`;
}

/** Written into the dive so the next `jump` hands the whole picture to the next agent. */
export function renderGateReport(gates: LandGate[], outcome: GateOutcome): string {
	const lines: string[] = [];
	lines.push(`Elapsed: ${(outcome.elapsedMs / 1000).toFixed(1)}s.`);
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
