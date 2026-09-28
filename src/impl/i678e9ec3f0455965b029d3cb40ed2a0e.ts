import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import type { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc, uuidLike } from "../lib/coreParsing.js";
import { findDocByQuid, matchDocs, mintDoc, type MintedDoc } from "../lib/crud.js";
import { readActiveDiveId } from "../lib/kbDocs.js";
import {
	kindSources,
	loadKinds,
	postCrudScriptPath,
	resolveKind,
	selectRepo,
	type KindDoc,
} from "../lib/kinds.js";
import { printCommandHelp } from "../lib/packageBacklog.js";

/** Removes `<flag> <value>` from args, wherever it sits, and returns the value. */
function takeFlag(args: string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	if (at === -1) return undefined;
	const value = args[at + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
	args.splice(at, 2);
	return value;
}

async function crud(args: string[], io: CommandIo, runtime: ImplRuntime): Promise<void> {
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		printCommandHelp("crud", io);
		if (args.length === 0) io.setExitCode(1);
		return;
	}
	const name = takeFlag(args, "--name");
	const repo = takeFlag(args, "--repo");
	const sources =
		repo === undefined ? kindSources(process.cwd()) : selectRepo(kindSources(process.cwd()), repo);
	if (args.length === 0) throw new Error("crud needs a kind and a gist, or a quid");
	const [first, ...rest] = args as [string, ...string[]];

	if (uuidLike(first)) {
		if (name !== undefined) throw new Error("crud <quid> takes no --name");
		if (rest.length > 0) throw new Error(`crud <quid> takes nothing else: ${rest.join(" ")}`);
		const path = findDocByQuid(sources, first);
		if (!path) throw new Error(`no doc ${first} in context`);
		io.writeOut(readFileSync(path, "utf8"));
		return;
	}

	const gist = rest.join(" ").trim();
	if (!gist) throw new Error(`crud ${first} requires a gist`);
	const kind = resolveKind(loadKinds(sources), first);
	if (!kind) {
		const rc = readNosediveRc(process.cwd());
		throw new Error(
			readActiveDiveId(rc.workspaceDir)
				? `no kind ${first} in context: no repo the active dive scopes declares it`
				: `no kind ${first} in context: the bridge kb declares none by that name, and \`nosedive seed\` copies in nosedive's own`,
		);
	}

	const matches = matchDocs(kind, gist);
	if (matches.length === 1) {
		io.writeOut(readFileSync(matches[0]!.path, "utf8"));
		return;
	}
	if (matches.length > 1)
		throw new Error(
			`${matches.length} ${kind.name} docs match ${JSON.stringify(gist)}; name one by quid: ` +
				matches.map((match) => `${match.id} (${match.name})`).join(", "),
		);

	const script = postCrudScriptPath(kind);
	await mintDoc(
		kind,
		gist,
		io,
		name,
		script ? postCrudHook(script, kind, gist, io, runtime) : undefined,
	);
}

/**
 * A kind's post-crud-script, told what crud just did so it can decide whether
 * to act, and handed what a command adapter gets. A throw or a nonzero exit
 * fails the crud.
 */
function postCrudHook(
	script: string,
	kind: KindDoc,
	gist: string,
	io: CommandIo,
	runtime: ImplRuntime,
): (doc: MintedDoc) => Promise<void> {
	return async (doc) => {
		const mod = (await import(pathToFileURL(script).href)) as Record<string, unknown>;
		if (typeof mod.postCrud !== "function")
			throw new Error(
				`post-crud-script of kind ${kind.name} must export postCrud(value, ctx): ${script}`,
			);
		const result = (await mod.postCrud(
			{ action: "create", kind: kind.name, gist, doc, root: kind.source.root },
			{ cwd: process.cwd(), impl: runtime.impl },
		)) as ImplCommandOutput | undefined;
		if (result?.stdout) io.writeOut(result.stdout);
		if (result?.stderr) io.writeErr(result.stderr);
		if (result && result.exitCode !== 0)
			throw new Error(`post-crud-script of kind ${kind.name} exited ${result.exitCode}`);
	};
}

export function run(args: string[], runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => crud(commandArgs, io, runtime), args);
}
