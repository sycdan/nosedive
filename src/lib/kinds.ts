import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { BASE_CONFIG_FILENAME, BRIDGE_STATE_DIRNAME } from "./constants.js";
import { formatPath, parseYamlBlock, readNosediveRc, resolveFrom } from "./coreParsing.js";
import { loadKbDocs, readActiveDiveId, readKbDoc, readKbDocById } from "./kbDocs.js";
import { writeFileAtomic } from "./renderPlan.js";
import { expectedWorktreePath } from "./repoWorktrees.js";

/** A repo whose kb can declare kinds, named and identified so `--repo` can pick it. */
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
/** Shipped kinds whose docs live only in a bridge, and whose crud does more than write the doc. */
export const DECK_KIND_ID = "00000000-0000-7d1f-805a-7d0a3bdff309";
export const DIVE_KIND_ID = "00000000-0000-77cb-bcfe-6c9fb07f42ab";
const BRIDGE_ONLY = new Set([DECK_KIND_ID, DIVE_KIND_ID]);

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

/**
 * A deck or a dive lives only in a bridge, so a copy of its kind in a repo in
 * play that is not one -- a scoped nosedive checkout -- is not a candidate.
 */
export function bridgeHomed(kinds: KindDoc[]): KindDoc[] {
	return kinds.filter(
		(kind) =>
			!BRIDGE_ONLY.has(kind.id) ||
			existsSync(join(kind.source.root, BRIDGE_STATE_DIRNAME, BASE_CONFIG_FILENAME)),
	);
}

/**
 * The one kind a name means in context. A name several repos in play define
 * is refused rather than guessed; `--repo` narrows the context to one.
 */
export function resolveKind(kinds: KindDoc[], ref: string): KindDoc | undefined {
	const matches = kinds.filter((kind) => kind.name === ref);
	if (matches.length > 1) {
		const named = matches
			.map((kind) => `${kind.source.name} (${formatPath(kind.path)})`)
			.join(", ");
		throw new Error(
			`kind ${ref} is defined by more than one repo in context: ${named}; pick one with --repo <repo>`,
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

/** Validates a doc's meta against its kind in context, or warns that nothing in context declares it. */
export function checkDocMeta(
	kinds: KindDoc[],
	doc: { kind: string; meta: unknown },
): { kind?: KindDoc; errors: string[]; warning?: string } {
	const kind = resolveKind(kinds, doc.kind);
	if (!kind)
		return { errors: [], warning: `no kind ${doc.kind} in context; its meta is not validated` };
	return { kind, errors: validateMeta(kind, doc.meta) };
}
