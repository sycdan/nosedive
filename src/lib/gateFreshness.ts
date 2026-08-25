import { relative } from "node:path";

import { toPosixPath } from "./coreParsing.js";
import { runGit } from "./gitProcess.js";
import { LandGate } from "./landGates.js";

/**
 * The gates whose source on disk differs from what the bridge has committed.
 *
 * A gate is two files and only one of them is written by a command: `record.gate`
 * mints the doc beside a stub that fails on purpose, and the pilot writes the
 * real check into that stub by hand. Nothing stages it, and `land` stashes
 * everything unstaged around its push, so an uncommitted check runs green on the
 * pilot's machine and reaches no clone. What gets published is the stub, which
 * fails for a reason nobody's work caused.
 *
 * One `git status` over every gate's two paths rather than one call per gate:
 * the answer is the same and a land already spends enough on git.
 */
export function dirtyGates(bridgeDir: string, gates: LandGate[]): LandGate[] {
	if (gates.length === 0) return [];
	const pathsOf = (gate: LandGate) =>
		[gate.doc.path, gate.scriptPath].map((path) => toPosixPath(relative(bridgeDir, path)));
	// Raw stdout, never `gitOutput`: that trims, and porcelain's first status
	// column is a space for a worktree-only change -- exactly the case this
	// exists to catch. A bridge that is not a git repository has nothing to
	// publish from, and reports itself here as a non-zero exit.
	const result = runGit(bridgeDir, ["status", "--porcelain", "--", ...gates.flatMap(pathsOf)]);
	if (result.status !== 0) return [];
	const dirty = new Set(
		result.stdout
			.split(/\r?\n/)
			.filter((line) => line.length > 0)
			// Porcelain v1 is two status columns, a space, then the path, and a
			// rename adds `orig -> new`. Neither quoting nor the rename form can
			// arise here: both paths are `kb/<uuid>` shaped, and no command renames
			// them.
			.map((line) => line.slice(3).split(" -> ").at(-1)!),
	);
	return gates.filter((gate) => pathsOf(gate).some((path) => dirty.has(path)));
}

/** How a pilot publishes each one, listed so the refusal is also the fix. */
export function describeDirtyGates(gates: LandGate[]): string {
	return gates.map((gate) => `  ${gate.doc.name}: nosedive record.gate ${gate.doc.id}`).join("\n");
}
