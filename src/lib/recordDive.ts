import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";

import { titleFromSlug } from "./backlogDives.js";
import { CommandIo } from "./bridgeSetupIo.js";
import { DIVE_BRIEF_HEADING, DIVE_BRIEF_HEADING_PATTERN } from "./constants.js";
import { formatPath, parseMarkdownDoc, readNosediveRc, stringifyYaml } from "./coreParsing.js";
import { KbDoc, ScopeRef, loadKbDocs } from "./kbDocs.js";
import { gitOutput, quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import { reconcileDiveEffortLinks, resolveEffortDoc } from "./repoEffortScopes.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	parseRepoMarkerStrict,
	uuidLike,
} from "./repoWorkspaceCore.js";
import { expectedWorktreePath, resolveRefCommit } from "./repoWorktrees.js";
import { uuid7AtMs } from "./uuid7.js";

export interface RecordDiveOptions {
	ref?: string;
	effort?: string;
	gist?: string;
	title?: string;
	brief?: string;
	diver?: string;
	scopes: string[];
	clearScopes: boolean;
}

function optionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseRecordDiveArgs(args: string[]): RecordDiveOptions {
	const options: RecordDiveOptions = { scopes: [], clearScopes: false };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--clear-scopes") {
			options.clearScopes = true;
			continue;
		}
		const flag = ["--ref", "--effort", "--gist", "--title", "--brief", "--diver", "--scope"].find(
			(candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
		);
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown record.dive option: ${arg}`);
			throw new Error(`unexpected record.dive argument: ${arg}`);
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		if (flag === "--scope") options.scopes.push(value);
		else if (flag === "--ref") options.ref = value;
		else if (flag === "--effort") options.effort = value;
		else if (flag === "--gist") options.gist = value;
		else if (flag === "--title") options.title = value;
		else if (flag === "--brief") options.brief = value;
		else options.diver = value;
	}
	if (options.clearScopes && options.scopes.length > 0) {
		throw new Error("--clear-scopes cannot be combined with --scope");
	}
	if (!options.ref && !options.effort)
		throw new Error("record.dive requires --effort when creating a dive");
	if (!options.ref && options.gist !== undefined && !options.gist.trim()) {
		throw new Error("gist cannot be empty");
	}
	if (options.brief !== undefined && !options.brief.trim())
		throw new Error("brief cannot be empty");
	return options;
}

function bridgeRelativePath(bridgeDir: string, pathRef: string): string {
	if (!pathRef || pathRef.includes("\\"))
		throw new Error(`invalid bridge-relative path: ${pathRef}`);
	const path = resolve(bridgeDir, pathRef);
	if (relative(bridgeDir, path).startsWith("..")) {
		throw new Error(`path resolves outside this bridge: ${pathRef}`);
	}
	if (!existsSync(path)) throw new Error(`path not found: ${pathRef}`);
	return path;
}

function docFromMarker(path: string, kbDocs: KbDoc[]): KbDoc {
	const markerPath = statSync(path).isDirectory() ? join(path, ".nosedive-ref") : path;
	if (basename(markerPath) !== ".nosedive-ref")
		throw new Error(`not a document or .nosedive-ref: ${formatPath(path)}`);
	const marker = parseRepoMarkerStrict(markerPath);
	const doc = kbDocs.find((candidate) => candidate.id === marker.id);
	if (!doc) throw new Error(`marker references no kb document: ${formatPath(markerPath)}`);
	return doc;
}

export function resolveBridgeDocRef(bridgeDir: string, kbDocs: KbDoc[], ref: string): KbDoc {
	if (uuidLike(ref)) {
		const doc = kbDocs.find((candidate) => candidate.id === ref);
		if (!doc) throw new Error(`kb document not found: ${ref}`);
		return doc;
	}
	const path = bridgeRelativePath(bridgeDir, ref);
	if (basename(path) === ".nosedive-ref") return docFromMarker(path, kbDocs);
	if (statSync(path).isDirectory()) return docFromMarker(path, kbDocs);
	if (!statSync(path).isFile()) throw new Error(`not a document or .nosedive-ref: ${ref}`);
	const doc = kbDocs.find((candidate) => resolve(candidate.path) === path);
	if (!doc) throw new Error(`file is not a kb document: ${ref}`);
	return doc;
}

function resolveScopeRepo(bridgeDir: string, kbDocs: KbDoc[], ref: string): KbDoc {
	const doc = uuidLike(ref)
		? kbDocs.find((candidate) => candidate.id === ref)
		: resolveBridgeDocRef(bridgeDir, kbDocs, ref);
	if (!doc) throw new Error(`kb document not found: ${ref}`);
	if (doc.kind !== "repo") throw new Error(`scope does not resolve to a kind: repo doc: ${ref}`);
	return doc;
}

function defaultReadOnly(repo: KbDoc): boolean {
	const mode = repo.metaScalars["default-mode"];
	if (mode === undefined || mode === "rw") return false;
	if (mode === "ro") return true;
	throw new Error(`repo ${repo.id} has invalid meta.default-mode: ${mode}`);
}

function cachedScope(repo: KbDoc, bridgeDir: string, workspaceDir: string): ScopeRef {
	const path = expectedWorktreePath(repo, bridgeDir);
	ensureSafeTargetPath(repo.id, path, workspaceDir);
	const existing = existsSync(path) && statSync(path).isDirectory();
	let readOnly = defaultReadOnly(repo);
	if (existing && existsSync(join(path, ".nosedive-ref"))) {
		const marker = parseRepoMarkerStrict(join(path, ".nosedive-ref"));
		if (marker.id !== repo.id)
			throw new Error(`workspace marker does not match repo ${repo.id}: ${formatPath(path)}`);
		readOnly =
			gitOutput(path, ["config", "--get", "remote.origin.pushurl"]) === "no_push://disabled";
	}
	const cache = ensureManagedRepoCache(repo, bridgeDir);
	const trunk = repo.repoBaseBranch ?? "main";
	return {
		repoId: repo.id,
		path: "",
		ref: resolveRefCommit(cache, repo.id, trunk),
		readOnly,
		flags: [],
	};
}

function renderScopes(scopes: ScopeRef[]): string[] {
	if (scopes.length === 0) return ["scopes: []"];
	const lines = ["scopes:"];
	for (const scope of scopes) {
		lines.push(
			`  - ${scope.repoId}:`,
			`      ref: ${scope.ref}`,
			`      mode: ${scope.readOnly ? "ro" : "rw"}`,
		);
	}
	return lines;
}

function effortTitle(effort: KbDoc): string {
	const body = readFileSync(effort.path, "utf8");
	return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || titleFromSlug(effort.name.split(".")[0]!);
}

function managedName(effort: KbDoc, id: string): string {
	return `${effort.name}.${id.replaceAll("-", "").slice(-6)}`;
}

function renderNewDive(
	id: string,
	effort: KbDoc,
	options: RecordDiveOptions,
	scopes: ScopeRef[],
): string {
	const gist = options.gist?.trim() || `Working on ${effortTitle(effort)}.`;
	const lines = [
		"---",
		"kind: dive",
		`id: ${id}`,
		`name: ${managedName(effort, id)}`,
		`gist: ${quoteYamlString(gist)}`,
		...renderScopes(scopes),
		"meta:",
		`  effort: ${effort.id}`,
		`  diver: ${options.diver ? quoteYamlString(options.diver) : "null"}`,
		"---",
		"",
		`# ${options.title?.trim() || "Dive Record"}`,
	];
	if (options.brief?.trim()) lines.push("", DIVE_BRIEF_HEADING, "", options.brief.trim());
	lines.push("");
	return lines.join("\n");
}

function replaceTitle(body: string, title: string): string {
	if (/^#\s+.*$/m.test(body)) return body.replace(/^#\s+.*$/m, `# ${title}`);
	return `# ${title}\n\n${body}`;
}

function activeDive(kbDocs: KbDoc[], workspaceDir: string): KbDoc | undefined {
	const markerPath = join(workspaceDir, ".nosedive-ref");
	if (!existsSync(markerPath)) return undefined;
	const marker = parseRepoMarkerStrict(markerPath);
	const doc = kbDocs.find((candidate) => candidate.id === marker.id);
	if (!doc || doc.kind !== "dive")
		throw new Error(`active marker names no kind: dive doc: ${formatPath(markerPath)}`);
	return doc;
}

function ensureActivation(
	target: KbDoc | { id: string },
	diver: string | undefined,
	pilotEmail: string,
	active: KbDoc | undefined,
): boolean {
	if (!diver || diver !== pilotEmail) return false;
	if (!active || active.id === target.id) return true;
	if (active.metaScalars.diver === diver) {
		throw new Error(`pilot already has active dive ${active.id}; land or hand it off first`);
	}
	throw new Error(`workspace already has active dive ${active.id}`);
}

export function recordDive(args: string[], io: CommandIo): void {
	const options = parseRecordDiveArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("record.dive requires a configured kb directory");
	if (!rc.workspaceDir) throw new Error("record.dive requires a configured workspace directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const active = activeDive(kbDocs, rc.workspaceDir);
	const pilotEmail = gitOutput(rc.bridgeDir, ["config", "user.email"]) ?? "";
	const workspaceDir = rc.workspaceDir;

	if (!options.ref) {
		if (active) throw new Error(`workspace already has active dive ${active.id}`);
		const effort = resolveEffortDoc(kbDocs, rc, options.effort!);
		const scopes = options.clearScopes
			? []
			: options.scopes.length > 0
				? options.scopes.map((ref) =>
						cachedScope(resolveScopeRepo(rc.bridgeDir, kbDocs, ref), rc.bridgeDir, workspaceDir),
					)
				: effort.scopes.map((scope) =>
						cachedScope(
							resolveScopeRepo(rc.bridgeDir, kbDocs, scope.repoId),
							rc.bridgeDir,
							workspaceDir,
						),
					);
		if (new Set(scopes.map((scope) => scope.repoId)).size !== scopes.length)
			throw new Error("duplicate repo scope");
		const id = uuid7AtMs(Date.now());
		const path = join(rc.kbDir, `${id}.md`);
		writeFileAtomic(path, renderNewDive(id, effort, options, scopes));
		reconcileDiveEffortLinks(undefined, effort, id, options.diver);
		if (ensureActivation({ id }, options.diver, pilotEmail, active))
			writeFileAtomic(join(workspaceDir, ".nosedive-ref"), `id: ${id}\n`);
		io.log(`Recorded ${formatPath(path)}`);
		return;
	}

	const dive = resolveBridgeDocRef(rc.bridgeDir, kbDocs, options.ref);
	if (dive.kind !== "dive")
		throw new Error(`--ref does not resolve to a kind: dive doc: ${options.ref}`);
	const text = readFileSync(dive.path, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(dive.path));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in frontmatter in ${formatPath(dive.path)}`);
	const previousEffort = dive.effortRef
		? resolveEffortDoc(kbDocs, rc, dive.effortRef)
		: undefined;
	const effort = options.effort
		? resolveEffortDoc(kbDocs, rc, options.effort)
		: previousEffort;
	if (options.effort) {
		if (!effort) throw new Error(`dive ${dive.id} names no effort in meta.effort`);
		doc.set("name", managedName(effort, dive.id));
		doc.setIn(["meta", "effort"], effort.id);
	}
	if (options.gist !== undefined) doc.set("gist", options.gist.trim());
	if (options.diver !== undefined) {
		doc.setIn(["meta", "diver"], options.diver || null);
	}
	if (options.clearScopes || options.scopes.length > 0) {
		const scopes = options.clearScopes
			? []
			: options.scopes.map((ref) =>
					cachedScope(resolveScopeRepo(rc.bridgeDir, kbDocs, ref), rc.bridgeDir, workspaceDir),
				);
		if (new Set(scopes.map((scope) => scope.repoId)).size !== scopes.length)
			throw new Error("duplicate repo scope");
		doc.set(
			"scopes",
			scopes.map((scope) => ({
				[scope.repoId]: { ref: scope.ref, mode: scope.readOnly ? "ro" : "rw" },
			})),
		);
	}
	let body = options.title?.trim() ? replaceTitle(parsed.body, options.title.trim()) : parsed.body;
	if (options.brief?.trim()) {
		// Write-once: the brief is what informed everything already built on this
		// dive, so a second one is a new dive, not an edit.
		if (DIVE_BRIEF_HEADING_PATTERN.test(body)) {
			throw new Error(
				`dive already has a brief: ${formatPath(dive.path)}; bail and pitch a new dive instead of rewriting it`,
			);
		}
		body = `${body.trimEnd()}\n\n${DIVE_BRIEF_HEADING}\n\n${options.brief.trim()}\n`;
	}
	writeFileAtomic(dive.path, ["---", stringifyYaml(doc).trimEnd(), "---", body].join("\n"));
	if (effort) {
		const diver = options.diver !== undefined ? options.diver || undefined : dive.metaScalars.diver;
		reconcileDiveEffortLinks(previousEffort, effort, dive.id, diver);
	}
	if (ensureActivation(dive, options.diver, pilotEmail, active)) {
		writeFileAtomic(join(workspaceDir, ".nosedive-ref"), `id: ${dive.id}\n`);
	}
	io.log(`Recorded ${formatPath(dive.path)}`);
}
