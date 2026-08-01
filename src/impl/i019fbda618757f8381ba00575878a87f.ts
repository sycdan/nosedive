import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { parseMarkdownDoc, readNosediveRc } from "../lib/coreParsing.js";
import { uuidLike } from "../lib/repoWorkspaceCore.js";

function dumpBacklogMemo(args: string[], io: CommandIo): void {
	if (args.length > 0) throw new Error(`unexpected dump-backlog argument: ${args[0]}`);

	const rc = readNosediveRc(process.cwd());
	const id = rc.backlog;
	if (!id) throw new Error("dump-backlog requires a configured backlog memo id");
	if (!uuidLike(id)) throw new Error(`dump-backlog requires a UUID-shaped backlog memo id: ${id}`);
	if (!rc.kbDir) throw new Error("dump-backlog requires a configured kb directory");

	const docPath = join(rc.kbDir, `${id}.md`);
	if (!existsSync(docPath)) throw new Error(`bridge backlog memo not found: ${id}`);
	if (!statSync(docPath).isFile()) throw new Error(`bridge backlog memo is not a file: ${id}`);
	io.writeOut(parseMarkdownDoc(readFileSync(docPath, "utf8"), docPath).body);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(dumpBacklogMemo, args);
}
