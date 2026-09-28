import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import type { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc, uuidLike } from "../lib/coreParsing.js";
import { findDocByQuid, matchDocs, mintDoc } from "../lib/crud.js";
import { readActiveDiveId } from "../lib/kbDocs.js";
import { crudScriptPath, kindSources, loadKinds, resolveKind } from "../lib/kinds.js";
import { printCommandHelp } from "../lib/packageBacklog.js";

async function crud(args: string[], io: CommandIo, runtime: ImplRuntime): Promise<void> {
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		printCommandHelp("crud", io);
		if (args.length === 0) io.setExitCode(1);
		return;
	}
	const nameAt = args.indexOf("--name");
	const name = nameAt === -1 ? undefined : args[nameAt + 1];
	if (nameAt !== -1 && !name) throw new Error("--name needs a value");
	if (nameAt !== -1) args = [...args.slice(0, nameAt), ...args.slice(nameAt + 2)];
	const sources = kindSources(process.cwd());
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

	const script = crudScriptPath(kind);
	if (!script) {
		mintDoc(kind, gist, io, name);
		return;
	}
	if (name !== undefined)
		throw new Error(
			`kind ${kind.name} mints through its crud-script, which names the doc itself; drop --name`,
		);
	// A kind that mints its own way gets what a command adapter gets.
	const mod = (await import(pathToFileURL(script).href)) as Record<string, unknown>;
	if (typeof mod.crud !== "function")
		throw new Error(`crud-script of kind ${kind.name} must export crud(value, ctx): ${script}`);
	const result = (await mod.crud(
		{ args: rest, kind: kind.name, gist, root: kind.source.root },
		{ cwd: process.cwd(), impl: runtime.impl },
	)) as ImplCommandOutput;
	if (result.stdout) io.writeOut(result.stdout);
	if (result.stderr) io.writeErr(result.stderr);
	if (result.exitCode !== 0) io.setExitCode(result.exitCode);
}

export function run(args: string[], runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => crud(commandArgs, io, runtime), args);
}
