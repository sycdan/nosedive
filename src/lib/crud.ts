import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { formatPath } from "./coreParsing.js";
import { runGit } from "./gitProcess.js";
import { readKbDoc, type KbDoc } from "./kbDocs.js";
import { validateMeta, type KindDoc, type KindSource } from "./kinds.js";
import { writeFileAtomic } from "./renderPlan.js";
import { slugFromGist } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export interface CrudMatch {
	id: string;
	name: string;
	path: string;
}

/**
 * A gist names a doc whose gist makes the same slug -- so case and
 * punctuation do not matter -- or whose name is that slug, which finds a doc
 * somebody named by hand.
 */
export function gistSlug(gist: string): string {
	const slug = slugFromGist(gist, 60);
	if (!slug) throw new Error(`gist has nothing to slug: ${JSON.stringify(gist)}`);
	return slug;
}

/** Every doc of a kind in the kb of the repo that defines it. */
function docsOfKind(kind: KindDoc): KbDoc[] {
	const kbDir = kind.source.kbDir;
	if (!existsSync(kbDir)) return [];
	const kindLine = `kind: ${kind.name}`;
	return readdirSync(kbDir)
		.filter((file) => file.endsWith(".md"))
		.filter((file) =>
			readFileSync(join(kbDir, file), "utf8")
				.split(/\r?\n/)
				.some((line) => line.trimEnd() === kindLine),
		)
		.map((file) => readKbDoc(join(kbDir, file), kind.source.root));
}

/** Docs of a kind, in the kb of the repo that defines it, that a gist names. */
export function matchDocs(kind: KindDoc, gist: string): CrudMatch[] {
	const slug = gistSlug(gist);
	return docsOfKind(kind)
		.filter((doc) => doc.name === slug || slugFromGist(doc.gist, 60) === slug)
		.map((doc) => ({ id: doc.id, name: doc.name, path: doc.path }));
}

/**
 * Mints a doc of a kind where the kind is defined, and commits it there: the
 * bridge with no dive, a scoped repo's worktree on one, for land to publish.
 * It is named by its own id -- the mark of a doc nobody has named yet, so the
 * gist is what finds it again -- unless a name is given, which must be free
 * among the docs of its kind in that repo.
 * The new doc's meta is validated first, so a kind that requires meta refuses
 * a bare mint rather than committing a doc it would reject.
 *
 * `afterWrite` is the kind's post-crud-script, run once the doc is on disk.
 * Whatever it changes in the repo joins the doc's commit; if it fails, the doc
 * is removed and nothing is committed.
 */
export async function mintDoc(
	kind: KindDoc,
	gist: string,
	io: { log(message: string): void },
	name?: string,
	afterWrite?: (doc: MintedDoc) => Promise<void>,
): Promise<string> {
	gistSlug(gist); // refuses a gist with nothing in it
	if (name !== undefined) {
		if (!NAME.test(name))
			throw new Error(
				`--name must be a leaf-first chain of kebab-case slugs joined by dots: ${JSON.stringify(name)}`,
			);
		const holder = docsOfKind(kind).find((doc) => doc.name === name);
		if (holder) throw new Error(`${kind.name} name ${name} is taken by ${holder.id}`);
	}
	const errors = validateMeta(kind, {});
	if (errors.length > 0)
		throw new Error(
			`a ${kind.name} cannot be minted without meta its kind requires:\n  ${errors.join("\n  ")}`,
		);
	const id = uuid7AtMs(Date.now());
	const path = join(kind.source.kbDir, `${id}.md`);
	const title = gist.trim();
	const root = kind.source.root;
	const before = dirtyState(root);
	writeFileAtomic(
		path,
		[
			"---",
			`kind: ${kind.name}`,
			`id: ${id}`,
			`name: ${name ?? id}`,
			`gist: ${JSON.stringify(title)}`,
			"---",
			"",
			`# ${title}`,
			"",
		].join("\n"),
	);
	io.log(`Minted ${formatPath(path)}`);
	if (afterWrite) {
		try {
			await afterWrite({ id, name: name ?? id, path });
		} catch (err) {
			rmSync(path, { force: true });
			throw err;
		}
	}
	const touched = [...dirtyState(root)]
		.filter(([file, hash]) => before.get(file) !== hash)
		.map(([file]) => join(root, file));
	commitBridgeDocs(root, `crud(${id}): created ${kind.name} ${name ?? id}`, [path, ...touched], io);
	return id;
}

/**
 * Every path git sees as changed or untracked in a repo, with a hash of what
 * is on disk now, so what a hook changed can be told from what was already
 * dirty before it ran.
 */
function dirtyState(root: string): Map<string, string> {
	const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	const state = new Map<string, string>();
	const entries = status.stdout.split("\0").filter(Boolean);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		// A rename carries its old path as the next entry.
		if (entry[0] === "R" || entry[0] === "C") i++;
		const file = entry.slice(3);
		const absolute = join(root, file);
		state.set(
			file,
			existsSync(absolute)
				? createHash("sha1").update(readFileSync(absolute)).digest("hex")
				: "gone",
		);
	}
	return state;
}

export interface MintedDoc {
	id: string;
	name: string;
	path: string;
}

/** The doc with this id in the first kb in context that holds one. */
export function findDocByQuid(sources: KindSource[], quid: string): string | undefined {
	return sources
		.map((source) => join(source.kbDir, `${quid.toLowerCase()}.md`))
		.find((path) => existsSync(path));
}
