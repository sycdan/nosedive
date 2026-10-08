import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { builtinKindPath, REPO_CREATE_GATE_ID } from "./builtinKinds.js";
import { renderUpdatedBacklogMemo } from "./backlogDives.js";
import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME } from "./constants.js";
import { checkLinkTargets } from "./crudLinks.js";
import { formatPath, readNosediveRc, uuidLike } from "./coreParsing.js";
import { loadKbDocs, readActiveDiveId, readKbDoc, readKbDocById, type KbDoc } from "./kbDocs.js";
import { parseScopeRefs } from "./kbRefs.js";
import {
	checkDocMeta,
	isBridge,
	REPO_KIND_ID,
	validateMeta,
	type KindDoc,
	type KindSource,
} from "./kinds.js";
import { entriesToMapping, isMapping, mappingToEntries, mergePatch } from "./mergePatch.js";
import { writeFileAtomic } from "./renderPlan.js";
import { reconcileLinkTarget } from "./repoFeatScopes.js";
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
 * gist is what finds it again -- unless a name is given, which is slugged to
 * kebab-case (each dot-joined part on its own) and must be free
 * among the docs of its kind in that repo.
 * The new doc's meta -- `meta`, or none -- is validated first, so a kind that
 * requires meta refuses a mint without it rather than committing a doc it
 * would reject.
 */
/** A repo's remotes may say `{id}` for the id it is about to be minted with. */
function withRemoteIds(meta: Record<string, unknown>, id: string): Record<string, unknown> {
	if (!isMapping(meta.remotes)) return meta;
	const remotes = Object.fromEntries(
		Object.entries(meta.remotes).map(([key, value]) => [
			key,
			typeof value === "string" ? value.replaceAll("{id}", id) : value,
		]),
	);
	return { ...meta, remotes };
}

export function mintDoc(
	kind: KindDoc,
	gist: string,
	io: { log(message: string): void },
	name?: string,
	meta: Record<string, unknown> = {},
): string {
	gistSlug(gist); // refuses a gist with nothing in it
	if (name !== undefined) {
		const given = name;
		name = given
			.split(".")
			.map((part) => slugFromGist(part, 60) ?? "")
			.join(".");
		if (!NAME.test(name))
			throw new Error(`--name has nothing to slug between its dots: ${JSON.stringify(given)}`);
		const holder = docsOfKind(kind).find((doc) => doc.name === name);
		if (holder) throw new Error(`${kind.name} name ${name} is taken by ${holder.id}`);
	}
	const errors = validateMeta(kind, meta);
	if (errors.length > 0)
		throw new Error(
			`a ${kind.name} cannot be minted with that meta; pass what its kind requires with --meta -:\n  ${errors.join("\n  ")}`,
		);
	const id = uuid7AtMs(Date.now());
	if (kind.id === REPO_KIND_ID) meta = withRemoteIds(meta, id);
	const path = join(kind.source.kbDir, `${id}.md`);
	const title = gist.trim();
	writeFileAtomic(
		path,
		[
			"---",
			`kind: ${kind.name}`,
			`id: ${id}`,
			`name: ${name ?? id}`,
			`gist: ${JSON.stringify(title)}`,
			...(Object.keys(meta).length > 0
				? stringifyYaml({ meta }, { lineWidth: 0 }).replace(/\n$/, "").split("\n")
				: []),
			"---",
			"",
			`# ${title}`,
			"",
		].join("\n"),
	);
	io.log(`Minted ${formatPath(path)}`);
	commitBridgeDocs(kind.source.root, `crud(${id}): created ${kind.name} ${name ?? id}`, [path], io);
	linkMintToActiveDive(kind, id, io);
	return id;
}

/**
 * The live dive is jump's and land's record, even when the doc lives in __self.
 * A repo doc also brings the shipped repo-create gate, which makes the repo at land.
 */
function linkMintToActiveDive(kind: KindDoc, id: string, io: { log(message: string): void }): void {
	const source = kind.source;
	const rc = readNosediveRc(process.cwd());
	const activeId = readActiveDiveId(rc.workspaceDir);
	if (!activeId || !rc.kbDir) return;
	const dive = readKbDocById(rc.kbDir, rc.bridgeDir, activeId);
	if (!dive || dive.kind !== "dive")
		throw new Error(`active dive ${activeId} has no live dive doc`);
	if (!source.id) throw new Error(`cannot link ${id} from the active dive: its repo has no id`);
	const target = source.id === rc.bridge ? `kb/${id}.md` : `${source.id}:kb/${id}.md`;
	reconcileLinkTarget(dive.path, target, "made");
	if (kind.id === REPO_KIND_ID)
		reconcileLinkTarget(dive.path, `kb/${REPO_CREATE_GATE_ID}.md`, "land.gate");
	commitBridgeDocs(rc.bridgeDir, `dive(${dive.name}): linked made ${id}`, [dive.path], io);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const TOP_LEVEL_KEY = /^[^\s#]/;

/** The frontmatter blocks crud writes, each ahead of the ones after it in KINGSMetaL order. */
export const BLOCKS = ["scopes", "meta", "links"] as const;
export type Block = (typeof BLOCKS)[number];

/**
 * The frontmatter lines with the `key:` block replaced by `block` (or removed,
 * when it is empty). A doc without one gets it where KINGSMetaL order puts
 * it: before the first later block present, or last. Every other line is left
 * as it was.
 */
function withBlock(lines: string[], key: Block, block: string[]): string[] {
	const start = lines.findIndex((line) => line.startsWith(`${key}:`));
	if (start !== -1) {
		let end = start + 1;
		while (end < lines.length && !TOP_LEVEL_KEY.test(lines[end]!)) end++;
		return [...lines.slice(0, start), ...block, ...lines.slice(end)];
	}
	const later = BLOCKS.slice(BLOCKS.indexOf(key) + 1)
		.map((next) => lines.findIndex((line) => line.startsWith(`${next}:`)))
		.filter((at) => at !== -1);
	const at = later.length > 0 ? Math.min(...later) : lines.length;
	return [...lines.slice(0, at), ...block, ...lines.slice(at)];
}

/**
 * A patch's targets as the doc writes them: a scope names its repo by id, so
 * a repo name is looked up in the doc's own kb; a link to a quid is the kb
 * path of that doc.
 */
function patchTargets(block: Block, patch: Record<string, unknown>, target: CrudTarget) {
	if (block === "meta") return patch;
	const repos =
		block === "scopes"
			? loadKbDocs(target.source.kbDir, target.source.root).filter((doc) => doc.kind === "repo")
			: [];
	const kbRel = relative(target.source.root, target.source.kbDir).split("\\").join("/") || ".";
	return Object.fromEntries(
		Object.entries(patch).map(([key, value]) => {
			if (block === "links")
				return [uuidLike(key) ? `${kbRel}/${key.toLowerCase()}.md` : key, value];
			if (uuidLike(key)) return [key.toLowerCase(), value];
			const repo = repos.find((doc) => doc.name === key);
			if (!repo) throw new Error(`no repo named ${key} in ${formatPath(target.source.kbDir)}`);
			return [repo.id, value];
		}),
	);
}

/** Every new dive takes the backlog's scopes, so dropping the bridge there cuts them all off its kb. */
function keepBridgeOnBacklog(id: string, before: object, after: object): void {
	const rc = readNosediveRc(process.cwd());
	if (id !== rc.backlog || !rc.bridge || !(rc.bridge in before) || rc.bridge in after) return;
	throw new Error(
		"the backlog keeps the bridge in its scopes: every new dive takes them, and without it none can write the bridge kb",
	);
}

/**
 * Applies `patch` to one frontmatter block of a doc and rewrites only that
 * block. The patch is a JSON Merge Patch (RFC 7386): keys merge recursively
 * and a null removes one. `scopes` and `links` are patched as mappings keyed
 * by target, so one entry is added, changed or removed by naming it. With
 * `replace`, the patch is the whole new block. A doc's meta is validated
 * against its kind first; a kind not in context writes with a warning.
 */
export function updateBlock(
	target: CrudTarget,
	kinds: KindDoc[],
	block: Block,
	patch: Record<string, unknown>,
	replace: boolean,
	io: { log(message: string): void; err(message: string): void },
	/** The repos in play, where a bare link can find the nearest copy of its doc. */
	inPlay: KindSource[],
	title?: string,
): void {
	const text = readFileSync(target.path, "utf8");
	const match = FRONTMATTER.exec(text);
	if (!match) throw new Error(`${formatPath(target.path)} has no frontmatter`);
	const fm = parseYaml(match[1]!) as Record<string, unknown>;
	const kindName = String(fm.kind ?? "");
	const id = String(fm.id ?? "");
	const name = String(fm.name ?? id);
	const where = formatPath(target.path);
	const current =
		block === "meta" ? (fm.meta ?? {}) : entriesToMapping(fm[block], `${where} ${block}`);
	if (!isMapping(current)) throw new Error(`${where} has a meta that is not a mapping`);
	const targets = patchTargets(block, patch, target);
	if (block === "links")
		checkLinkTargets(patch, targets, target.source, parseScopeRefs(fm.scopes, target.path), inPlay);
	const merged = (replace ? mergePatch({}, targets) : mergePatch(current, targets)) as Record<
		string,
		unknown
	>;
	if (block === "scopes") keepBridgeOnBacklog(id, current, merged);

	let kind: KindDoc | undefined;
	if (block === "meta") {
		const checked = checkDocMeta(kinds, { kind: kindName, meta: merged }, target.source);
		if (checked.errors.length > 0)
			throw new Error(`the ${kindName} meta would not validate:\n  ${checked.errors.join("\n  ")}`);
		if (checked.warning) io.err(checked.warning);
		kind = checked.kind;
	}

	const value = block === "meta" ? merged : mappingToEntries(merged, block);
	const lines =
		Object.keys(merged).length === 0
			? []
			: stringifyYaml({ [block]: value }, { lineWidth: 0 })
					.replace(/\n$/, "")
					.split("\n");
	const yaml = withBlock(match[1]!.split(/\r?\n/), block, lines).join("\n");
	const patched = `---\n${yaml}\n---\n${text.slice(match[0].length)}`;
	let next = title === undefined ? patched : withTitle(patched, title);
	if (block === "links" && id === repoBacklog(target.source.root))
		next = renderUpdatedBacklogMemo(
			next,
			target.path,
			loadKbDocs(target.source.kbDir, target.source.root),
		);
	if (next === text) {
		io.log(`Unchanged ${where}`);
		return;
	}
	writeFileAtomic(target.path, next);
	io.log(`Updated ${where}`);
	commitBridgeDocs(
		target.source.root,
		`crud(${id}): updated ${kind?.name ?? kindName} ${name}`,
		[target.path],
		io,
	);
}

/** A doc crud found, and the repo in context it was found in. */
export interface CrudTarget {
	path: string;
	source: KindSource;
}

/** The doc with this id in the first kb in context that holds one. */
export function findDocByQuid(sources: KindSource[], quid: string): CrudTarget | undefined {
	const path = builtinKindPath(quid.toLowerCase());
	const bridge = sources.find((source) => isBridge(source));
	if (path && bridge) return { path, source: bridge };
	for (const source of sources) {
		const local = join(source.kbDir, `${quid.toLowerCase()}.md`);
		if (existsSync(local)) return { path: local, source };
	}
	return undefined;
}

/**
 * The backlog a repo's own config names. Read from the checkout, not through
 * `readNosediveRc`: a sub-bridge hydrated in a workspace resolves to the outer bridge.
 */
function repoBacklog(root: string): string | undefined {
	const config = join(root, BRIDGE_STATE_DIRNAME, BASE_CONFIG_FILENAME);
	if (!existsSync(config)) return undefined;
	return /^backlog:\s*(\S+)\s*$/m.exec(readFileSync(config, "utf8"))?.[1];
}

/** Set the body's first h1, preserving the frontmatter and remaining body. */
function withTitle(text: string, title: string): string {
	if (!title.trim() || /[\r\n]/.test(title))
		throw new Error("--title requires a nonempty single line");
	const match = FRONTMATTER.exec(text);
	if (!match) throw new Error("doc has no frontmatter");
	const body = text.slice(match[0].length);
	const heading = /^#[ \t]+[^\r\n]*\r?$/m;
	const nextBody = heading.test(body)
		? body.replace(heading, () => `# ${title.trim()}`)
		: `\n# ${title.trim()}\n\n${body.replace(/^\s*\n/, "")}`;
	return match[0] + nextBody;
}

export function updateTitle(
	target: CrudTarget,
	title: string,
	io: { log(message: string): void },
): void {
	const text = readFileSync(target.path, "utf8");
	const next = withTitle(text, title);
	if (next === text) {
		io.log(`Unchanged ${formatPath(target.path)}`);
		return;
	}
	const doc = readKbDoc(target.path, target.source.root);
	writeFileAtomic(target.path, next);
	commitBridgeDocs(
		target.source.root,
		`crud(${doc.id}): updated ${doc.kind} ${doc.name}`,
		[target.path],
		io,
	);
}
