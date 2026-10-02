import { existsSync, readFileSync } from "node:fs";

import { parseDocument } from "yaml";

import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { baseConfigPath, parseYamlBlock, readNosediveRc, type NosediveRc } from "./coreParsing.js";
import { appendHelmLog } from "./helmLog.js";
import { HelmRequestError, runCrud } from "./helmWrites.js";
import { loadKbDocs, readActiveDiveId, type KbDoc } from "./kbDocs.js";
import { writeFileAtomic } from "./renderPlan.js";
import { listedRoots } from "./roots.js";

export interface HelmRootsResult {
	id: string;
	output: string;
}

/** The bridge's memos, for the picker that lists one as a root. */
export function helmMemos(cwd: string): { id: string; name: string; gist: string }[] {
	return bridgeDocs(readNosediveRc(cwd))
		.filter((doc) => doc.kind === "memo" && doc.id)
		.map((doc) => ({ id: doc.id!, name: doc.name, gist: doc.gist }));
}

function bridgeDocs(rc: NosediveRc): KbDoc[] {
	return rc.kbDir && existsSync(rc.kbDir) ? loadKbDocs(rc.kbDir, rc.bridgeDir) : [];
}

function noDive(rc: NosediveRc, action: string): void {
	if (readActiveDiveId(rc.workspaceDir))
		throw new HelmRequestError(409, `cannot ${action} a root while a dive is active`);
}

/** Runs a roots action and logs it, whatever the outcome, as `roots <verb> <id>`. */
async function loggedRoots(
	cwd: string,
	verb: string,
	id: () => string,
	run: () => Promise<HelmRootsResult>,
): Promise<HelmRootsResult> {
	const dive = readActiveDiveId(readNosediveRc(cwd).workspaceDir);
	try {
		const result = await run();
		appendHelmLog(cwd, dive, ["roots", verb, result.id], `${result.output}\n[exit 0]`);
		return result;
	} catch (err) {
		appendHelmLog(cwd, dive, ["roots", verb, id()], `${(err as Error).message}\n[exit 1]`);
		throw err;
	}
}

/** The bridge config's text and the ids its `roots:` lists. */
function readRoots(rc: NosediveRc): { path: string; text: string; listed: string[] } {
	const path = baseConfigPath(rc.bridgeDir);
	if (!existsSync(path))
		throw new HelmRequestError(400, "this bridge has no .nosedive/config.yaml");
	const text = readFileSync(path, "utf8");
	return { path, text, listed: listedRoots(parseYamlBlock(text, path).raw.roots) };
}

/** Writes `roots:` as one comma string, unfolded, or drops the key when none are left. */
function writeRoots(path: string, text: string, roots: string[]): void {
	const config = parseDocument(text);
	if (roots.length) config.set("roots", roots.join(", "));
	else config.delete("roots");
	writeFileAtomic(path, config.toString({ lineWidth: 0 }));
}

function commitRoots(rc: NosediveRc, path: string, subject: string): string {
	const said: string[] = [];
	commitBridgeDocs(rc.bridgeDir, subject, [path], { log: (line) => said.push(line) });
	return said.join("\n");
}

/**
 * Lists a memo as a root: `{ id }` an existing memo in the bridge kb, or
 * `{ name, gist }` one crud mints first. Commits the config, never pushes.
 * The backlog, always a root, and a memo already listed are left as they are.
 */
export function helmAddRoot(cwd: string, body: Record<string, unknown>): Promise<HelmRootsResult> {
	const given = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
	let id = given;
	return loggedRoots(
		cwd,
		"add",
		() => id || String(body.name ?? body.gist ?? ""),
		async () => {
			const rc = readNosediveRc(cwd);
			noDive(rc, "add");
			const output: string[] = [];
			let name: string;
			if (given) {
				const doc = bridgeDocs(rc).find((d) => d.id === given);
				if (!doc) throw new HelmRequestError(400, `no doc ${given} in the bridge kb`);
				if (doc.kind !== "memo")
					throw new HelmRequestError(
						400,
						`a root is a memo, and ${doc.name} is a ${doc.kind ?? "doc without a kind"}`,
					);
				name = doc.name || given;
			} else {
				const gist = typeof body.gist === "string" ? body.gist.trim() : "";
				const wanted = typeof body.name === "string" ? body.name.trim() : "";
				if (!gist) throw new HelmRequestError(400, "a root needs an id, or a gist for a new memo");
				const run = await runCrud(cwd, ["memo", ...(wanted ? ["--name", wanted] : []), gist]);
				const said = `${run.stdout}${run.stderr}`.trim();
				if (run.exitCode !== 0)
					throw new HelmRequestError(
						400,
						run.stderr.replace(/^nosedive: /gm, "").trim() || `crud exited ${run.exitCode}`,
					);
				const minted = /Minted \S*?([0-9a-f-]{36})\.md/.exec(run.stdout)?.[1];
				if (!minted) throw new HelmRequestError(500, `crud did not report a new memo:\n${said}`);
				id = minted;
				name = wanted || minted;
				output.push(said);
			}
			const { path, text, listed } = readRoots(rc);
			if (id === rc.backlog) {
				output.push(`${name} is the backlog, always a root; nothing changed`);
				return { id, output: output.join("\n") };
			}
			if (listed.includes(id)) {
				output.push(`${name} is already a root; nothing changed`);
				return { id, output: output.join("\n") };
			}
			writeRoots(path, text, [...listed, id]);
			output.push(`Listed ${id} in roots:`);
			output.push(commitRoots(rc, path, `roots: listed ${name}`));
			output.push("nothing was pushed");
			return { id, output: output.filter(Boolean).join("\n") };
		},
	);
}

/** Unlists a root, committed and not pushed; the memo itself is untouched. */
export function helmRemoveRoot(cwd: string, rawId: string): Promise<HelmRootsResult> {
	const id = rawId.trim().toLowerCase();
	return loggedRoots(
		cwd,
		"remove",
		() => id,
		async () => {
			const rc = readNosediveRc(cwd);
			noDive(rc, "remove");
			if (!id) throw new HelmRequestError(400, "id is required");
			if (id === rc.backlog)
				throw new HelmRequestError(400, "the backlog is always a root and cannot be unlisted");
			const { path, text, listed } = readRoots(rc);
			if (!listed.includes(id)) throw new HelmRequestError(409, `${id} is not a listed root`);
			writeRoots(
				path,
				text,
				listed.filter((entry) => entry !== id),
			);
			const name = bridgeDocs(rc).find((d) => d.id === id)?.name || id;
			const output = [
				`Unlisted ${id} from roots:`,
				commitRoots(rc, path, `roots: unlisted ${name}`),
			];
			output.push("nothing was pushed");
			return { id, output: output.filter(Boolean).join("\n") };
		},
	);
}
