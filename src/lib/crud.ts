import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { formatPath } from "./coreParsing.js";
import { readKbDoc } from "./kbDocs.js";
import { validateMeta, type KindDoc, type KindSource } from "./kinds.js";
import { writeFileAtomic } from "./renderPlan.js";
import { slugFromGist } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

export interface CrudMatch {
	id: string;
	name: string;
	path: string;
}

/**
 * A gist names a doc by its gist, ignoring case, or by the slug it makes --
 * which finds a doc somebody named by hand.
 */
export function gistSlug(gist: string): string {
	const slug = slugFromGist(gist, 60);
	if (!slug) throw new Error(`gist has nothing to slug: ${JSON.stringify(gist)}`);
	return slug;
}

/** Docs of a kind, in the kb of the repo that defines it, that a gist names. */
export function matchDocs(kind: KindDoc, gist: string): CrudMatch[] {
	const kbDir = kind.source.kbDir;
	if (!existsSync(kbDir)) return [];
	const kindLine = new RegExp(
		`^kind: ${kind.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
		"m",
	);
	const slug = gistSlug(gist);
	const text = gist.trim().toLowerCase();
	return readdirSync(kbDir)
		.filter((file) => file.endsWith(".md"))
		.filter((file) => kindLine.test(readFileSync(join(kbDir, file), "utf8")))
		.map((file) => readKbDoc(join(kbDir, file), kind.source.root))
		.filter((doc) => doc.name === slug || doc.gist.trim().toLowerCase() === text)
		.map((doc) => ({ id: doc.id, name: doc.name, path: doc.path }));
}

/**
 * Mints a doc of a kind where the kind is defined, and commits it there: the
 * bridge with no dive, a scoped repo's worktree on one, for land to publish.
 * It is named by its own id -- the mark of a doc nobody has named yet -- so
 * the gist is what finds it again.
 * The new doc's meta is validated first, so a kind that requires meta refuses
 * a bare mint rather than committing a doc it would reject.
 */
export function mintDoc(kind: KindDoc, gist: string, io: { log(message: string): void }): string {
	gistSlug(gist); // refuses a gist with nothing in it
	const errors = validateMeta(kind, {});
	if (errors.length > 0)
		throw new Error(
			`a ${kind.name} cannot be minted without meta its kind requires:\n  ${errors.join("\n  ")}`,
		);
	const id = uuid7AtMs(Date.now());
	const path = join(kind.source.kbDir, `${id}.md`);
	const title = gist.trim();
	writeFileAtomic(
		path,
		[
			"---",
			`kind: ${kind.name}`,
			`id: ${id}`,
			`name: ${id}`,
			`gist: ${JSON.stringify(title)}`,
			"---",
			"",
			`# ${title}`,
			"",
		].join("\n"),
	);
	io.log(`Minted ${formatPath(path)}`);
	commitBridgeDocs(kind.source.root, `${kind.name}(${id}): created`, [path], io);
	return id;
}

/** The doc with this id in the first kb in context that holds one. */
export function findDocByQuid(sources: KindSource[], quid: string): string | undefined {
	return sources
		.map((source) => join(source.kbDir, `${quid.toLowerCase()}.md`))
		.find((path) => existsSync(path));
}
