import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import {
	defaultEffortName,
	loadKbDocs,
	mintEffortId,
	parsePitchArgs,
	renderPitchedEffort,
} from "../lib/kbDocs.js";
import { writeFileAtomic } from "../lib/renderPlan.js";
import { appendLinkToDoc, effortDocs, resolveEffortDoc } from "../lib/repoEffortScopes.js";

function pitch(args: string[], io: CommandIo): void {
	const options = parsePitchArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("pitch requires a configured kb directory");
	// A freshly seeded bridge has no kb directory until something writes to it.
	if (!existsSync(rc.kbDir)) mkdirSync(rc.kbDir, { recursive: true });

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const parent = options.parent ? resolveEffortDoc(kbDocs, rc, options.parent) : undefined;
	const leaf = options.name ?? defaultEffortName();
	const name = parent ? `${leaf}.${parent.name}` : leaf;

	const clash = effortDocs(kbDocs).find((doc) => doc.name === name);
	if (clash) throw new Error(`effort already exists: ${name} (${clash.id})`);

	const id = mintEffortId();
	const path = join(rc.kbDir, `${id}.md`);
	if (existsSync(path)) throw new Error(`kb doc already exists: ${formatPath(path)}`);
	writeFileAtomic(
		path,
		renderPitchedEffort({ id, name, gist: options.gist, parentId: parent?.id }),
	);
	if (parent) appendLinkToDoc(parent.path, id, "child.feat");

	io.log(`Pitched ${formatPath(path)}`);
	// The backlog renders from its own links, so an unparented feat is reachable
	// from nothing until the memo names it.
	if (!parent) io.log(`Add it to the backlog with: nosedive update-backlog --inject ${id}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(pitch, args);
}
