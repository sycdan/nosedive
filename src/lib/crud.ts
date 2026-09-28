import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { formatPath } from "./coreParsing.js";
import { runGit } from "./gitProcess.js";
import { readKbDoc, type KbDoc } from "./kbDocs.js";
import { checkDocMeta, validateMeta, type KindDoc, type KindSource } from "./kinds.js";
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
	await hookThenCommit(
		root,
		before,
		{ id, name: name ?? id, path },
		`crud(${id}): created ${kind.name} ${name ?? id}`,
		() => rmSync(path, { force: true }),
		io,
		afterWrite,
	);
	return id;
}

/**
 * Runs a kind's post-crud-script on a doc crud has just written, then commits
 * the doc with whatever the script changed in the repo. A failing script is
 * undone with the doc and nothing is committed.
 */
async function hookThenCommit(
	root: string,
	before: Map<string, string>,
	doc: MintedDoc,
	subject: string,
	undo: () => void,
	io: { log(message: string): void },
	afterWrite?: (doc: MintedDoc) => Promise<void>,
): Promise<void> {
	if (afterWrite) {
		try {
			await afterWrite(doc);
		} catch (err) {
			undo();
			throw err;
		}
	}
	const touched = [...dirtyState(root)]
		.filter(([file, hash]) => before.get(file) !== hash)
		.map(([file]) => join(root, file));
	commitBridgeDocs(root, subject, [doc.path, ...touched], io);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const TOP_LEVEL_KEY = /^[^\s#]/;

/**
 * The frontmatter lines with the `meta:` block replaced by `block` (or
 * removed, when it is empty). A doc without meta gets it where KINGSMetaL
 * order puts it: before `links:`, or last. Every other line is left as it was.
 */
function withMetaBlock(lines: string[], block: string[]): string[] {
	const start = lines.findIndex((line) => /^meta:/.test(line));
	if (start !== -1) {
		let end = start + 1;
		while (end < lines.length && !TOP_LEVEL_KEY.test(lines[end]!)) end++;
		return [...lines.slice(0, start), ...block, ...lines.slice(end)];
	}
	const links = lines.findIndex((line) => /^links:/.test(line));
	const at = links === -1 ? lines.length : links;
	return [...lines.slice(0, at), ...block, ...lines.slice(at)];
}

/**
 * Merges `patch` into a doc's meta -- a null value removes its key -- after
 * validating the result against the doc's kind, and rewrites only the meta
 * block. A doc whose kind is not in context is written with a warning.
 */
export async function updateMeta(
	target: CrudTarget,
	kinds: KindDoc[],
	patch: Record<string, unknown>,
	io: { log(message: string): void; err(message: string): void },
	afterWrite?: (doc: MintedDoc) => Promise<void>,
): Promise<void> {
	const text = readFileSync(target.path, "utf8");
	const match = FRONTMATTER.exec(text);
	if (!match) throw new Error(`${formatPath(target.path)} has no frontmatter`);
	const fm = parseYaml(match[1]!) as Record<string, unknown>;
	const kindName = String(fm.kind ?? "");
	const id = String(fm.id ?? "");
	const name = String(fm.name ?? id);
	const current = fm.meta ?? {};
	if (typeof current !== "object" || Array.isArray(current))
		throw new Error(`${formatPath(target.path)} has a meta that is not a mapping`);
	const merged: Record<string, unknown> = { ...(current as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}

	const { kind, errors, warning } = checkDocMeta(kinds, { kind: kindName, meta: merged });
	if (errors.length > 0)
		throw new Error(`the ${kindName} meta would not validate:\n  ${errors.join("\n  ")}`);
	if (warning) io.err(warning);

	const block =
		Object.keys(merged).length === 0
			? []
			: stringifyYaml({ meta: merged }, { lineWidth: 0 }).replace(/\n$/, "").split("\n");
	const yaml = withMetaBlock(match[1]!.split(/\r?\n/), block).join("\n");
	const next = `---\n${yaml}\n---\n${text.slice(match[0].length)}`;
	if (next === text) {
		io.log(`Unchanged ${formatPath(target.path)}`);
		return;
	}
	const before = dirtyState(target.source.root);
	writeFileAtomic(target.path, next);
	io.log(`Updated ${formatPath(target.path)}`);
	await hookThenCommit(
		target.source.root,
		before,
		{ id, name, path: target.path },
		`crud(${id}): updated ${kind?.name ?? kindName} ${name}`,
		() => writeFileAtomic(target.path, text),
		io,
		afterWrite,
	);
}

/**
 * Every file git sees as changed or untracked in a repo, with a hash of what
 * is on disk now, so what a hook changed can be told from what was already
 * dirty before it ran. Untracked directories stay collapsed and are skipped --
 * a bridge's workspace is one, full of nested checkouts -- so a hook's new file
 * is seen only where git already tracks the directory it lands in.
 */
function dirtyState(root: string): Map<string, string> {
	const status = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
	const state = new Map<string, string>();
	const entries = status.stdout.split("\0").filter(Boolean);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		// A rename carries its old path as the next entry.
		if (entry[0] === "R" || entry[0] === "C") i++;
		const file = entry.slice(3);
		const absolute = join(root, file);
		if (file.endsWith("/") || (existsSync(absolute) && statSync(absolute).isDirectory())) continue;
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

/** A doc crud found, and the repo in context it was found in. */
export interface CrudTarget {
	path: string;
	source: KindSource;
}

/** The doc with this id in the first kb in context that holds one. */
export function findDocByQuid(sources: KindSource[], quid: string): CrudTarget | undefined {
	for (const source of sources) {
		const path = join(source.kbDir, `${quid.toLowerCase()}.md`);
		if (existsSync(path)) return { path, source };
	}
	return undefined;
}
