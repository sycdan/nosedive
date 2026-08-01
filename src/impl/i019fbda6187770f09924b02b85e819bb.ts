import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { pascalFromSlug, resolveParentDir } from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath } from "../lib/coreParsing.js";
import { parsePitchArgs, renderPitchedEffort } from "../lib/kbDocs.js";
import { loadBacklogConfig } from "../lib/packageBacklog.js";
import { writeFileAtomic } from "../lib/renderPlan.js";

function pitch(args: string[], io: CommandIo): void {
	const { slug, gist, pitch: pitchText, parent } = parsePitchArgs(args);
	const { bridgeDir, backlogDir } = loadBacklogConfig(process.cwd());
	const parentDir = parent ? resolveParentDir(parent, bridgeDir, backlogDir) : backlogDir;
	if (!existsSync(backlogDir)) mkdirSync(backlogDir, { recursive: true });

	const effortDir = join(parentDir, slug);
	if (existsSync(effortDir)) throw new Error(`effort already exists: ${formatPath(effortDir)}`);
	const effortPath = join(effortDir, `${pascalFromSlug(slug)}.md`);
	writeFileAtomic(effortPath, renderPitchedEffort(slug, gist, pitchText));

	io.log(`Pitched ${formatPath(effortPath)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(pitch, args);
}
