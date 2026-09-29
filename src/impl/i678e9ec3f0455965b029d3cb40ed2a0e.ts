import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import type { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc, uuidLike } from "../lib/coreParsing.js";
import {
	BLOCKS,
	findDocByQuid,
	matchDocs,
	mintDoc,
	updateBlock,
	type Block,
	type MintedDoc,
} from "../lib/crud.js";
import { readActiveDiveId, readKbDoc } from "../lib/kbDocs.js";
import {
	kindSources,
	loadKinds,
	postCrudScriptPath,
	resolveKind,
	selectRepo,
	type KindDoc,
} from "../lib/kinds.js";
import { printCommandHelp } from "../lib/packageBacklog.js";
import { readStdinText } from "../lib/stdinText.js";

const hint = (block: Block) =>
	`--${block} reads a merge patch from stdin: echo 'key: value' | nosedive crud <quid> --${block} -`;

/** Removes `--meta -`, `--scopes -` or `--links -` from args; stdin is the only place a patch is read from. */
function takeBlock(args: string[]): Block | undefined {
	const named = BLOCKS.filter((block) => args.includes(`--${block}`));
	if (named.length > 1)
		throw new Error(`crud patches one block at a time: ${named.map((b) => `--${b}`).join(", ")}`);
	const block = named[0];
	if (!block) return undefined;
	const at = args.indexOf(`--${block}`);
	if (args[at + 1] !== "-") throw new Error(hint(block));
	args.splice(at, 2);
	return block;
}

/** Removes a bare `<flag>` from args, and says whether it was there. */
function takeSwitch(args: string[], flag: string): boolean {
	const at = args.indexOf(flag);
	if (at === -1) return false;
	args.splice(at, 1);
	return true;
}

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
	const block = takeBlock(args);
	const replace = takeSwitch(args, "--replace");
	if (replace && !block) throw new Error("--replace goes with --meta, --scopes or --links");
	const name = takeFlag(args, "--name");
	const repo = takeFlag(args, "--repo");
	const sources =
		repo === undefined ? kindSources(process.cwd()) : selectRepo(kindSources(process.cwd()), repo);
	if (args.length === 0) throw new Error("crud needs a kind and a gist, or a quid");
	const [first, ...rest] = args as [string, ...string[]];

	if (uuidLike(first)) {
		if (name !== undefined) throw new Error("crud <quid> takes no --name");
		if (rest.length > 0) throw new Error(`crud <quid> takes nothing else: ${rest.join(" ")}`);
		const target = findDocByQuid(sources, first);
		if (!target) throw new Error(`no doc ${first} in context`);
		if (!block) {
			io.writeOut(readFileSync(target.path, "utf8"));
			return;
		}
		const patch = parseYaml(readStdinText(hint(block))) as unknown;
		if (!patch || typeof patch !== "object" || Array.isArray(patch))
			throw new Error(`--${block} reads a YAML or JSON mapping from stdin`);
		const kinds = loadKinds(sources);
		const doc = readKbDoc(target.path, target.source.root);
		const kind = resolveKind(kinds, doc.kind);
		const script = kind ? postCrudScriptPath(kind) : undefined;
		await updateBlock(
			target,
			kinds,
			block,
			patch as Record<string, unknown>,
			replace,
			io,
			kind && script ? postCrudHook("update", script, kind, doc.gist, io, runtime) : undefined,
		);
		return;
	}
	if (block)
		throw new Error(`--${block} updates a doc named by its quid: crud <quid> --${block} -`);

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

	// A name is the doc's identity when given: two docs may share a gist (helm's
	// default deck gist does, within a minute), so only the name is checked, by the mint.
	const matches = name === undefined ? matchDocs(kind, gist) : [];
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
		script ? postCrudHook("create", script, kind, gist, io, runtime) : undefined,
	);
}

/**
 * A kind's post-crud-script, told what crud just did so it can decide whether
 * to act, and handed what a command adapter gets. A throw or a nonzero exit
 * fails the crud.
 */
function postCrudHook(
	action: "create" | "update",
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
			{ action, kind: kind.name, gist, doc, root: kind.source.root },
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
