import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME } from "./constants.js";
import { formatPath, parseYamlBlock, readNosediveRc, resolveFrom } from "./coreParsing.js";
import { loadKbDocs, readActiveDiveId, readKbDoc, readKbDocById } from "./kbDocs.js";
import { writeFileAtomic } from "./renderPlan.js";
import { expectedWorktreePath } from "./repoWorktrees.js";

/** A repo whose kb can declare kinds, named and identified so a `<repo>:<ref>` can pick it. */
export interface KindSource {
	id?: string;
	name: string;
	root: string;
	kbDir: string;
}

export interface KindDoc {
	id: string;
	name: string;
	gist: string;
	path: string;
	source: KindSource;
	meta: Record<string, unknown>;
}

const KIND_LINE = /^kind: kind\s*$/m;
/** The shipped kind whose docs live only in a bridge, and whose crud does more than write the doc. */
export const DIVE_KIND_ID = "00000000-0000-77cb-bcfe-6c9fb07f42ab";
export const KIND_KIND_ID = "00000000-0000-70a0-90bd-1d49dc6264b9";
/** The shipped kind of a bridge's repo docs, which mint only into a bridge. */
export const REPO_KIND_ID = "00000000-0000-7dfa-bfc7-99ba38b8ed1e";
/** Shipped kinds whose docs live only in a bridge. */
const BRIDGE_ONLY = new Set([DIVE_KIND_ID, REPO_KIND_ID]);

/** What a new kind starts as when nobody says: closed, with nothing declared yet. */
export const STARTER_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

/** Minted at timestamp 0: the mark of a kind doc nosedive ships. */
export function isZerostar(id: string): boolean {
	return /^00000000-0000-/.test(id);
}

/** An installed repo keeps its kb where its nosedive config says; any other repo keeps it at `kb/`. */
export function repoKbDir(root: string): string {
	const config = join(root, BRIDGE_STATE_DIRNAME, BASE_CONFIG_FILENAME);
	if (existsSync(config)) {
		const kb = parseYamlBlock(readFileSync(config, "utf8"), config).scalars.kb;
		if (kb) return resolveFrom(root, kb);
	}
	return join(root, "kb");
}

/**
 * Where kinds come from right now. Kinds are contextual: with no active dive
 * they are the bridge's; on one they are the scoped repos' and nothing else,
 * because a doc written to the bridge mid-dive is outside what the dive packs.
 * The bridge counts on a dive only when the dive scopes it.
 */
export function kindSources(cwd: string): KindSource[] {
	const rc = readNosediveRc(cwd);
	if (!rc.kbDir) throw new Error("kinds require a configured kb directory");
	const docs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const activeId = readActiveDiveId(rc.workspaceDir);
	if (!activeId) {
		const bridgeDoc = rc.bridge ? docs.find((doc) => doc.id === rc.bridge) : undefined;
		return [
			{
				id: rc.bridge,
				name: bridgeDoc?.name ?? basename(rc.bridgeDir),
				root: rc.bridgeDir,
				kbDir: rc.kbDir,
			},
		];
	}
	const dive = readKbDocById(rc.kbDir, rc.bridgeDir, activeId);
	if (!dive) throw new Error(`active dive ${activeId} has no kb doc`);
	return dive.scopes
		.filter((scope) => scope.repoId !== ".")
		.map((scope) => {
			const repo = docs.find((doc) => doc.id === scope.repoId && doc.kind === "repo");
			if (!repo) throw new Error(`dive ${dive.name} scopes ${scope.repoId}, which has no repo doc`);
			const root = expectedWorktreePath(repo, rc.bridgeDir);
			if (!existsSync(root))
				throw new Error(`repo ${repo.name} is scoped on the active dive but not hydrated`);
			return { id: repo.id, name: repo.name, root, kbDir: repoKbDir(root) };
		});
}

function kindFiles(kbDir: string): string[] {
	if (!existsSync(kbDir)) return [];
	return readdirSync(kbDir)
		.filter((file) => file.endsWith(".md"))
		.filter((file) => KIND_LINE.test(readFileSync(join(kbDir, file), "utf8")))
		.sort();
}

export function loadKinds(sources: KindSource[]): KindDoc[] {
	return sources.flatMap((source) =>
		kindFiles(source.kbDir).map((file) => {
			const doc = readKbDoc(join(source.kbDir, file), source.root);
			return {
				id: doc.id,
				name: doc.name,
				gist: doc.gist,
				path: doc.path,
				source,
				meta: doc.metaRaw,
			};
		}),
	);
}

/** Narrows what is in play to one repo, named or identified; one out of play is refused. */
export function selectRepo(sources: KindSource[], ref: string): KindSource[] {
	const picked = sources.filter((source) => source.name === ref || source.id === ref);
	if (picked.length === 0)
		throw new Error(
			`repo ${ref} is not in context; in play: ${sources.map((source) => source.name).join(", ")}`,
		);
	return picked;
}

/** A bridge keeps its nosedive config at its root; no other repo does. */
export function isBridge(source: KindSource): boolean {
	return existsSync(join(source.root, BRIDGE_STATE_DIRNAME, BASE_CONFIG_FILENAME));
}

/**
 * A dive or a repo doc lives only in a bridge, so a copy of its kind in a repo
 * in play that is not one -- a scoped nosedive checkout -- is not a candidate.
 */
export function bridgeHomed(kinds: KindDoc[]): KindDoc[] {
	return kinds.filter((kind) => !BRIDGE_ONLY.has(kind.id) || isBridge(kind.source));
}

/** A kind nosedive ships, as a bridge holds it, that any repo can take; dive and repo stay home. */
export function isShipped(kind: KindDoc): boolean {
	return isZerostar(kind.id) && !BRIDGE_ONLY.has(kind.id) && isBridge(kind.source);
}

/**
 * The kind `name` means for a doc in `repo`: the repo's own, else -- outside a
 * bridge -- a shipped one, taken as the repo's so its docs are written and
 * found there.
 */
export function repoKind(kinds: KindDoc[], repo: KindSource, name: string): KindDoc | undefined {
	const own = resolveKind(
		bridgeHomed(kinds.filter((kind) => kind.source.root === repo.root)),
		name,
	);
	if (own || isBridge(repo)) return own;
	const shipped = kinds.find((kind) => isShipped(kind) && kind.name === name);
	return shipped && { ...shipped, source: repo };
}

/**
 * Splits `<repo>:<ref>` at its last colon; a repo is a name or an id, and an
 * id has no colon. Either side empty leaves the ref bare.
 */
export function parseQualifiedRef(ref: string): { repo?: string; ref: string } {
	const at = ref.lastIndexOf(":");
	if (at <= 0 || at === ref.length - 1) return { ref };
	return { repo: ref.slice(0, at), ref: ref.slice(at + 1) };
}

/**
 * The one kind a name means in context. A name several repos in play define
 * is refused rather than guessed; `<repo>:<kind>` names the repo to take it from.
 */
export function resolveKind(kinds: KindDoc[], ref: string): KindDoc | undefined {
	const parsed = parseQualifiedRef(ref);
	// A repo that declares no kinds has none to offer; that is "no kind", not "no repo".
	const candidates =
		parsed.repo === undefined
			? kinds
			: kinds.filter((kind) => kind.source.name === parsed.repo || kind.source.id === parsed.repo);
	const matches = candidates.filter((kind) => kind.name === parsed.ref);
	if (matches.length > 1) {
		const named = matches
			.map((kind) => `${kind.source.name} (${formatPath(kind.path)})`)
			.join(", ");
		const choices = matches.map((kind) => `${kind.source.name}:${parsed.ref}`).join(", ");
		throw new Error(
			`kind ${ref} is defined by more than one repo in context: ${named}; name one: ${choices}`,
		);
	}
	return matches[0];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const compiled = new Map<string, ValidateFunction | Error>();

function describe(error: ErrorObject): string {
	const extra =
		error.keyword === "additionalProperties"
			? ` (${String(error.params.additionalProperty)})`
			: error.keyword === "enum"
				? ` (${(error.params.allowedValues as unknown[]).join(", ")})`
				: "";
	return `${error.instancePath || "/"} ${error.message ?? error.keyword}${extra}`;
}

/** Path-qualified errors for `meta` against a kind's schema; none means valid. */
export function validateMeta(kind: KindDoc, meta: unknown): string[] {
	const key = `${kind.path}#${JSON.stringify(kind.meta.schema)}`;
	let validate = compiled.get(key);
	if (!validate) {
		try {
			validate = ajv.compile(kind.meta.schema as object);
		} catch (err) {
			validate = err instanceof Error ? err : new Error(String(err));
		}
		compiled.set(key, validate);
	}
	if (validate instanceof Error)
		return [`kind ${kind.name} has an invalid schema: ${validate.message}`];
	if (validate(meta ?? {})) return [];
	return (validate.errors ?? []).map(describe);
}

/**
 * Validates a doc's meta against its kind in context, or warns that nothing in
 * context declares it. When `source` says which repo the doc is in, a bare
 * kind is that repo's own or a shipped one first (`repoKind`).
 */
export function checkDocMeta(
	kinds: KindDoc[],
	doc: { kind: string; meta: unknown },
	source?: KindSource,
): { kind?: KindDoc; errors: string[]; warning?: string } {
	const parsed = parseQualifiedRef(doc.kind);
	const kind =
		(source && parsed.repo === undefined ? repoKind(kinds, source, parsed.ref) : undefined) ??
		resolveKind(kinds, doc.kind);
	if (!kind)
		return { errors: [], warning: `no kind ${doc.kind} in context; its meta is not validated` };
	return { kind, errors: validateMeta(kind, doc.meta) };
}
