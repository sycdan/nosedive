import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { BUILTIN_GATE_IDS, builtinDocPath } from "./builtinKinds.js";
import { formatPath, resolveFrom } from "./coreParsing.js";
import { KbDoc, readKbDoc } from "./kbDocs.js";
import { packageRoot } from "./packageBacklog.js";
import { unsafeLinkPath } from "./proveCore.js";

/**
 * `meta.test-script` is a bridge-relative path, resolved the same way patch and
 * prover artifacts are: no absolute paths, no traversal, no URIs. A gate that
 * cannot produce a runnable script is a hard failure -- silently skipping one
 * would turn a broken gate into a passing land.
 */
export function resolveGateScript(doc: KbDoc, bridgeDir: string): string {
	const label = `gate ${doc.id} (${doc.relPath}) meta.test-script`;
	// A shipped gate's script ships beside it, so it resolves in the package.
	const root = BUILTIN_GATE_IDS.has(doc.id) ? packageRoot() : gateSourceRoot(doc, bridgeDir);
	const rel = doc.metaScalars["test-script"];
	if (!rel) {
		throw new Error(
			`${label} is missing; add one naming the script that proves this gate, e.g. kb/artifacts/<quid>.mjs`,
		);
	}
	if (isAbsolute(rel) || unsafeLinkPath(rel)) {
		throw new Error(`${label} must be a bridge-relative path without traversal: ${rel}`);
	}
	const path = resolveFrom(root, rel);
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`${label} does not resolve to a file: ${formatPath(path)} -- create it`);
	}
	return path;
}

/** The bridge's docs by id, with shipped gates read from the package: a link names them by id alone. */
export function gateDocsById(kbDocs: KbDoc[]): Map<string, KbDoc> {
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	for (const id of BUILTIN_GATE_IDS) {
		const path = builtinDocPath(id);
		if (path) byId.set(id, readKbDoc(path, packageRoot()));
	}
	return byId;
}

/** The document and its relative path identify the checkout owning its script. */
export function gateSourceRoot(doc: KbDoc, bridgeDir: string): string {
	if (!doc.path) return resolve(bridgeDir);
	return resolve(
		dirname(doc.path),
		...doc.relPath
			.split(/[\\/]/)
			.slice(0, -1)
			.map(() => ".."),
	);
}

export function gateChangedOnDive(doc: KbDoc, bridgeDir: string): boolean {
	if (BUILTIN_GATE_IDS.has(doc.id) || gateSourceRoot(doc, bridgeDir) === resolve(bridgeDir))
		return false;
	const rel = doc.metaScalars["test-script"];
	if (!rel) return false;
	const liveDocPath = resolveFrom(bridgeDir, doc.relPath);
	if (!existsSync(liveDocPath)) return true;
	const liveDoc = readKbDoc(liveDocPath, bridgeDir);
	const liveRel = liveDoc.metaScalars["test-script"];
	if (!liveRel || isAbsolute(liveRel) || unsafeLinkPath(liveRel)) return true;
	const live = resolveFrom(bridgeDir, liveRel);
	return (
		!existsSync(live) ||
		!statSync(live).isFile() ||
		!readFileSync(live).equals(readFileSync(resolveGateScript(doc, bridgeDir)))
	);
}
