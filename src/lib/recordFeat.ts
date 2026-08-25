import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { injectDocsIntoBacklogMemo } from "./backlogDives.js";
import { CommandIo } from "./bridgeSetupIo.js";
import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { defaultWorkBranch, formatPath, NosediveRc, readNosediveRc } from "./coreParsing.js";
import { resolveBridgeDocRef } from "./diveScopes.js";
import { editKbDoc } from "./kbDocEdit.js";
import {
	KbDoc,
	loadKbDocs,
	mintFeatId,
	readKbDocById,
	renderKbDocTitle,
	repoDocs,
	retitleGeneratedHeading,
} from "./kbDocs.js";
import { bridgeDocRefPredicate, positionalGistNotice } from "./recordArgs.js";
import { printNextSteps } from "./nextSteps.js";
import { quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import {
	appendLinkToDoc,
	appendRepoScopeToFeat,
	featDocs,
	reconcileDocLink,
	resolveFeatDoc,
} from "./repoFeatScopes.js";
import { assertSlug, managedDiveName, slugFromGist } from "./slugs.js";

export interface RecordFeatOptions {
	/** The feat to patch. Absent means record a new one. */
	ref?: string;
	gist?: string;
	name?: string;
	parent?: string;
	/** `--no-parent`: the feat becomes a root of the backlog again. */
	unparent: boolean;
	/** The gist arrived as a positional, in the spelling this level deprecates. */
	positionalGist: boolean;
}

function optionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseRecordFeatArgs(
	args: string[],
	isDocRef: (arg: string) => boolean,
): RecordFeatOptions {
	const options: RecordFeatOptions = { unparent: false, positionalGist: false };

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		// The flag is the only way to say "root of the backlog again": a feat that
		// could be nested but never freed is a one-way door.
		if (arg === "--no-parent") {
			options.unparent = true;
			continue;
		}
		const flag = ["--gist", "--name", "--parent"].find(
			(candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
		);
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown record.feat option: ${arg}`);
			if (isDocRef(arg)) {
				if (options.ref !== undefined) throw new Error(`unexpected record.feat argument: ${arg}`);
				options.ref = arg;
			} else {
				if (options.gist !== undefined) throw new Error(`record.feat gist given twice: ${arg}`);
				options.gist = arg;
				options.positionalGist = true;
			}
			continue;
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		if (flag === "--gist") {
			if (options.gist !== undefined) throw new Error("record.feat gist given twice");
			options.gist = value;
		} else if (flag === "--name") options.name = assertSlug(value, "record.feat name");
		else options.parent = value;
	}

	if (options.gist !== undefined) {
		options.gist = options.gist.trim();
		if (!options.gist) throw new Error("gist cannot be empty");
	}
	if (options.parent !== undefined && options.unparent)
		throw new Error("--parent and --no-parent name different homes for the feat");
	if (options.ref === undefined) {
		if (options.gist === undefined) throw new Error('record.feat requires --gist "<one line>"');
		if (options.unparent) throw new Error("--no-parent needs a feat to unparent");
	}
	return options;
}

/**
 * An unnamed feat still needs a stable slug, and the time it was recorded is
 * the only thing that distinguishes it. Seconds resolution is enough: two
 * recorded in the same second would collide on name, and the duplicate check
 * catches that.
 */
export function defaultFeatName(now = new Date()): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return [
		"new-feat",
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
	].join("-");
}

export function renderRecordedFeat(options: {
	id: string;
	name: string;
	gist: string;
	parentId?: string;
}): string {
	const lines = [
		"---",
		"kind: feat",
		`id: ${options.id}`,
		`name: ${options.name}`,
		`gist: ${quoteYamlString(options.gist)}`,
	];
	if (options.parentId) {
		lines.push("links:", `  - kb/${options.parentId}.md:`, "      rel: parent.feat");
	}
	lines.push("---", "", renderKbDocTitle(options.name), "");
	return lines.join("\n");
}

function backlogMemoPath(rc: NosediveRc): string | undefined {
	return rc.backlog && rc.kbDir ? join(rc.kbDir, `${rc.backlog}.md`) : undefined;
}

function createFeat(rc: NosediveRc, kbDocs: KbDoc[], options: RecordFeatOptions, io: CommandIo) {
	const gist = options.gist!;
	const parent = options.parent ? resolveFeatDoc(kbDocs, rc, options.parent) : undefined;
	const existingNames = new Set(featDocs(kbDocs).map((doc) => doc.name));
	// An explicit --name wins outright. Otherwise derive a slug from the gist,
	// the way this command always has for the leaf's title -- but fall back to
	// the timestamp name if the derived slug collides or the gist yields nothing
	// usable, rather than refusing to record a feat at all.
	const derived = options.name ?? slugFromGist(gist);
	const derivedCombined = derived && (parent ? `${derived}.${parent.name}` : derived);
	const leaf =
		options.name ??
		(derivedCombined && !existingNames.has(derivedCombined) ? derived! : defaultFeatName());
	const name = parent ? `${leaf}.${parent.name}` : leaf;

	const clash = featDocs(kbDocs).find((doc) => doc.name === name);
	if (clash) throw new Error(`feat already exists: ${name} (${clash.id})`);

	const id = mintFeatId();
	const path = join(rc.kbDir!, `${id}.md`);
	if (existsSync(path)) throw new Error(`kb doc already exists: ${formatPath(path)}`);
	writeFileAtomic(path, renderRecordedFeat({ id, name, gist, parentId: parent?.id }));
	if (parent) appendLinkToDoc(parent.path, id, "child.feat");

	io.log(`Recorded ${formatPath(path)}`);
	// A feat that scopes nothing hands every gate declared on it an empty repo
	// set, so such a gate can never pass under `test`. Where the bridge registers
	// exactly one repo there is only one set it could have meant, and naming the
	// branch is what makes that scope writable. With several there is no
	// defensible guess, and a parented feat is left alone because it already
	// inherits its parent's scopes -- writing here would be a second source.
	const repos = repoDocs(kbDocs);
	const soleRepo = !parent && repos.length === 1 ? repos[0]! : undefined;
	if (soleRepo) {
		appendRepoScopeToFeat(path, { id: soleRepo.id, workBranch: defaultWorkBranch(rc, name) });
		io.log(`Scoped feat to the only registered repo: ${soleRepo.name} (${soleRepo.id})`);
	}

	// The backlog renders from its own links, so an unparented feat is reachable
	// from nothing until something names it. A parented feat is already
	// reachable through its parent, so only an unparented feat gets injected --
	// otherwise the feat would hang off two roots at once.
	let backlogPath: string | undefined;
	if (!parent) backlogPath = injectRoot(rc, kbDocs, id, io);

	commitBridgeDocs(
		rc.bridgeDir,
		`feat(${name}): created`,
		[path, parent?.path, backlogPath],
		io,
		id,
	);

	// A scoped feat has answered both flags already, so a pilot who typed them
	// would be choosing a repo and a branch that are no longer open questions.
	const upscope = soleRepo
		? ""
		: ` --upscope ${repos.length === 1 ? repos[0]!.name : "<repo>"} --work-branch work/${name}`;
	printNextSteps(io, [
		`nosedive record.dive --feat ${name} --gist "<one line>" --brief "<what done looks like>"` +
			upscope,
	]);
}

/** Link a root feat into the backlog memo, reporting the repair when it cannot. */
function injectRoot(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	id: string,
	io: CommandIo,
): string | undefined {
	const featDoc = readKbDocById(rc.kbDir!, rc.bridgeDir, id);
	if (!featDoc) throw new Error(`recorded doc not found after write: ${id}`);
	try {
		injectDocsIntoBacklogMemo(
			rc,
			[...kbDocs.filter((doc) => doc.id !== id), featDoc],
			[featDoc],
			io,
		);
		return backlogMemoPath(rc);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		io.log(`Could not link it to the backlog: ${message}`);
		io.log(`Finish it by hand with: nosedive update-backlog --inject ${id}`);
		return undefined;
	}
}

/**
 * Every document whose name has to move because this feat's did. A feat's name
 * is the leaf-first chain of its ancestors, and a dive's name is built from its
 * feat's, so renaming one feat renames its whole subtree -- leaving the rest
 * behind would have documents naming a feat that no longer exists.
 */
function renamedByFeat(
	kbDocs: KbDoc[],
	feat: KbDoc,
	newName: string,
): Array<{ doc: KbDoc; name: string }> {
	const renames = [{ doc: feat, name: newName }];
	const suffix = `.${feat.name}`;
	for (const doc of kbDocs) {
		if (doc.kind !== "feat" || doc.id === feat.id || !doc.name.endsWith(suffix)) continue;
		renames.push({ doc, name: doc.name.slice(0, -feat.name.length) + newName });
	}
	const featNames = new Map(renames.map((rename) => [rename.doc.id, rename.name]));
	for (const doc of kbDocs) {
		const featName = doc.kind === "dive" && doc.featRef ? featNames.get(doc.featRef) : undefined;
		if (featName) renames.push({ doc, name: managedDiveName(featName, doc.id) });
	}
	return renames;
}

function editFeat(rc: NosediveRc, kbDocs: KbDoc[], options: RecordFeatOptions, io: CommandIo) {
	const feat = resolveBridgeDocRef(rc.bridgeDir, kbDocs, options.ref!);
	if (feat.kind !== "feat") throw new Error(`does not resolve to a kind: feat doc: ${options.ref}`);
	const previousParent = kbDocs.find((doc) =>
		feat.links.some((link) => link.rel === "parent.feat" && link.id === doc.id),
	);
	const parent = options.parent
		? resolveFeatDoc(kbDocs, rc, options.parent)
		: options.unparent
			? undefined
			: previousParent;
	if (parent?.id === feat.id) throw new Error("a feat cannot be its own parent");
	if (parent && renamedByFeat(kbDocs, feat, feat.name).some((r) => r.doc.id === parent.id))
		throw new Error(`${parent.name} is under ${feat.name}; parenting it there would make a cycle`);

	const leaf = options.name ?? feat.name.split(".")[0]!;
	const name = parent ? `${leaf}.${parent.name}` : leaf;
	const clash = featDocs(kbDocs).find((doc) => doc.name === name && doc.id !== feat.id);
	if (clash) throw new Error(`feat already exists: ${name} (${clash.id})`);

	const renames = name === feat.name ? [] : renamedByFeat(kbDocs, feat, name);
	for (const rename of renames) {
		editKbDoc(rename.doc.path, (doc, body) => {
			doc.set("name", rename.name);
			return rename.doc.kind === "feat"
				? retitleGeneratedHeading(body, rename.doc.name, rename.name)
				: body;
		});
	}
	if (options.gist !== undefined) {
		editKbDoc(feat.path, (doc, body) => {
			doc.set("gist", options.gist);
			return body;
		});
	}

	const reparenting = options.parent !== undefined || options.unparent;
	let backlogPath: string | undefined;
	if (reparenting && previousParent?.id !== parent?.id) {
		if (previousParent) {
			reconcileDocLink(feat.path, previousParent.id, undefined);
			reconcileDocLink(previousParent.path, feat.id, undefined);
		}
		if (parent) {
			reconcileDocLink(feat.path, parent.id, "parent.feat");
			reconcileDocLink(parent.path, feat.id, "child.feat");
			// It is reachable through its parent now, so leaving the backlog's own
			// link in place would hang the feat off two roots at once.
			backlogPath = removeBacklogRoot(rc, feat.id);
		} else {
			backlogPath = injectRoot(rc, kbDocs, feat.id, io);
		}
		io.log(parent ? `Parented under ${parent.name}` : "Unparented; it is a backlog root again");
	}

	for (const rename of renames) io.log(`Renamed ${formatPath(rename.doc.path)} to ${rename.name}`);
	const committed = commitBridgeDocs(
		rc.bridgeDir,
		`feat(${name}): updated`,
		[
			...renames.map((rename) => rename.doc.path),
			feat.path,
			parent?.path,
			previousParent?.path,
			backlogPath,
		],
		io,
		feat.id,
	);
	io.log(
		committed ? `Updated ${formatPath(feat.path)}` : `Already published: ${formatPath(feat.path)}`,
	);
}

function removeBacklogRoot(rc: NosediveRc, featId: string): string | undefined {
	const path = backlogMemoPath(rc);
	if (!path || !existsSync(path)) return undefined;
	reconcileDocLink(path, featId, undefined);
	return path;
}

export function recordFeat(args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("record.feat requires a configured kb directory");
	// A freshly seeded bridge has no kb directory until something writes to it.
	if (!existsSync(rc.kbDir)) mkdirSync(rc.kbDir, { recursive: true });
	// Before the parse, because whether the positional is a document is a
	// question only the bridge can answer.
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const options = parseRecordFeatArgs(args, bridgeDocRefPredicate(rc.bridgeDir, kbDocs));
	if (options.positionalGist) io.err(positionalGistNotice("record.feat"));
	if (options.ref === undefined) createFeat(rc, kbDocs, options, io);
	else editFeat(rc, kbDocs, options, io);
}
