import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import {
	defaultFeatName,
	loadKbDocs,
	mintFeatId,
	parsePitchArgs,
	readKbDocById,
	renderPitchedFeat,
	repoDocs,
} from "../lib/kbDocs.js";
import { injectDocsIntoBacklogMemo } from "../lib/backlogDives.js";
import { writeFileAtomic } from "../lib/renderPlan.js";
import { appendLinkToDoc, featDocs, resolveFeatDoc } from "../lib/repoFeatScopes.js";
import { slugFromGist } from "../lib/slugs.js";

function pitch(args: string[], io: CommandIo): void {
	const options = parsePitchArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("pitch requires a configured kb directory");
	// A freshly seeded bridge has no kb directory until something writes to it.
	if (!existsSync(rc.kbDir)) mkdirSync(rc.kbDir, { recursive: true });

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const parent = options.parent ? resolveFeatDoc(kbDocs, rc, options.parent) : undefined;
	const existingNames = new Set(featDocs(kbDocs).map((doc) => doc.name));
	// An explicit --name wins outright. Otherwise derive a slug from the gist,
	// the way `pitch` always has for the leaf's title -- but fall back to the
	// timestamp name if the derived slug collides or the gist yields nothing
	// usable, rather than refusing to mint a feat at all.
	const derived = options.name ?? slugFromGist(options.gist);
	const derivedCombined = derived && (parent ? `${derived}.${parent.name}` : derived);
	const leaf =
		options.name ??
		(derivedCombined && !existingNames.has(derivedCombined) ? derived! : defaultFeatName());
	const name = parent ? `${leaf}.${parent.name}` : leaf;

	const clash = featDocs(kbDocs).find((doc) => doc.name === name);
	if (clash) throw new Error(`feat already exists: ${name} (${clash.id})`);

	const id = mintFeatId();
	const path = join(rc.kbDir, `${id}.md`);
	if (existsSync(path)) throw new Error(`kb doc already exists: ${formatPath(path)}`);
	writeFileAtomic(path, renderPitchedFeat({ id, name, gist: options.gist, parentId: parent?.id }));
	if (parent) appendLinkToDoc(parent.path, id, "child.feat");

	io.log(`Pitched ${formatPath(path)}`);
	// The backlog renders from its own links, so an unparented feat is reachable
	// from nothing until something names it. A parented feat is already
	// reachable through its parent, so only an unparented feat gets injected --
	// otherwise the feat would hang off two roots at once.
	if (!parent) {
		const featDoc = readKbDocById(rc.kbDir, rc.bridgeDir, id);
		if (!featDoc) throw new Error(`pitched doc not found after write: ${id}`);
		// The memo renders from the docs it is handed, and the one file written
		// since the sweep above is this feat -- the parented branch, which also
		// touches the parent doc, does not reach here.
		try {
			injectDocsIntoBacklogMemo(rc, [...kbDocs, featDoc], [featDoc], io);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			io.log(`Could not link it to the backlog: ${message}`);
			io.log(`Finish it by hand with: nosedive update-backlog --inject ${id}`);
		}
	}

	const repos = repoDocs(loadKbDocs(rc.kbDir, rc.bridgeDir));
	const repoName = repos.length === 1 ? repos[0]!.name : "<repo>";
	io.log(
		`nosedive record.dive --feat ${name} --gist "<one line>" --brief "<what done looks like>" ` +
			`--upscope ${repoName} --work-branch work/${name}`,
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(pitch, args);
}
