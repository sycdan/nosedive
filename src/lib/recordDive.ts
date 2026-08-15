import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";

import { diveTags, localOnlyKbDocIds } from "./diveListing.js";
import { CommandIo } from "./bridgeSetupIo.js";
import { DIVE_BRIEF_HEADING, DIVE_BRIEF_HEADING_PATTERN } from "./constants.js";
import {
	formatPath,
	NosediveRc,
	parseMarkdownDoc,
	readNosediveRc,
	stringifyYaml,
	uuidLike,
} from "./coreParsing.js";
import { KbDoc, ScopeRef, loadKbDocs, readKbDoc } from "./kbDocs.js";
import { gitOutput } from "./gitProcess.js";
import { quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import { reconcileDiveEffortLinks, resolveEffortDoc } from "./repoEffortScopes.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	parseRepoMarkerStrict,
} from "./repoWorkspaceCore.js";
import { isReadOnlyPushUrl } from "./repoHardening.js";
import { expectedWorktreePath, resolveRefCommit } from "./repoWorktrees.js";
import { titleFromSlug } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

export interface RecordDiveOptions {
	ref?: string;
	effort?: string;
	gist?: string;
	title?: string;
	brief?: string;
	diver?: string;
	takeover: boolean;
	free: boolean;
	scopes: string[];
	clearScopes: boolean;
}

function optionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseRecordDiveArgs(args: string[]): RecordDiveOptions {
	const options: RecordDiveOptions = {
		takeover: false,
		free: false,
		scopes: [],
		clearScopes: false,
	};
	let featValue: string | undefined;
	let effortValue: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--clear-scopes") {
			options.clearScopes = true;
			continue;
		}
		if (arg === "--free") {
			options.free = true;
			continue;
		}
		if (arg === "--takeover") {
			options.takeover = true;
			continue;
		}
		const flag = [
			"--ref",
			"--feat",
			"--effort",
			"--gist",
			"--title",
			"--brief",
			"--diver",
			"--scope",
		].find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown record.dive option: ${arg}`);
			throw new Error(`unexpected record.dive argument: ${arg}`);
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		if (flag === "--scope") options.scopes.push(value);
		else if (flag === "--ref") options.ref = value;
		else if (flag === "--feat") featValue = value;
		else if (flag === "--effort") effortValue = value;
		else if (flag === "--gist") options.gist = value;
		else if (flag === "--title") options.title = value;
		else if (flag === "--brief") options.brief = value;
		else options.diver = value;
	}
	if (featValue !== undefined && effortValue !== undefined && featValue !== effortValue) {
		throw new Error("--feat and --effort name different refs");
	}
	options.effort = featValue ?? effortValue;
	// A free dive takes its every field from the bridge, so any other option can
	// only describe a dive this is not: it is checked first, and returns before
	// the rules that assume an effort-owned dive.
	if (options.free) {
		if (args.length !== 1) throw new Error("--free cannot be combined with any other option");
		return options;
	}
	if (options.clearScopes && options.scopes.length > 0) {
		throw new Error("--clear-scopes cannot be combined with --scope");
	}
	if (!options.ref && !options.effort)
		throw new Error("record.dive requires --feat or --effort when creating a dive");
	if (!options.ref && options.gist !== undefined && !options.gist.trim()) {
		throw new Error("gist cannot be empty");
	}
	if (options.brief !== undefined && !options.brief.trim())
		throw new Error("brief cannot be empty");
	if (options.takeover) {
		// Takeover reads the holder off the dive and writes the pilot's own email,
		// so a --diver alongside it can only contradict one of the two.
		if (options.diver !== undefined) throw new Error("--takeover cannot be combined with --diver");
		if (!options.ref) throw new Error("--takeover requires --ref");
	}
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
		readOnly = isReadOnlyPushUrl(gitOutput(path, ["config", "--get", "remote.origin.pushurl"]));
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

/** `parent`, plus the role-suffixed spellings a deck-rooted tree uses (`parent.feat`, `parent.deck`). */
function isParentRel(rel: string | undefined): boolean {
	return rel === "parent" || (rel?.startsWith("parent.") ?? false);
}

/**
 * The scopes a dive under this effort should start from. `pitch` never writes a
 * scopes key, so reading only the effort's own scopes records a dive with none,
 * and a dive with no scope can be jumped with no repo attached and landed
 * without pushing anything. The nearest scoped ancestor is the one the pitcher
 * meant, so the walk stops there instead of unioning the whole chain.
 */
function inheritedScopes(effort: KbDoc, kbDocs: KbDoc[]): ScopeRef[] {
	const byId = new Map(kbDocs.map((doc) => [doc.id, doc]));
	const seen = new Set<string>();
	let current: KbDoc | undefined = effort;
	while (current && !seen.has(current.id)) {
		if (current.scopes.length > 0) return current.scopes;
		seen.add(current.id);
		current = current.links
			.filter((link) => isParentRel(link.rel))
			.map((link) => byId.get(link.id))
			.find((doc): doc is KbDoc => doc !== undefined);
	}
	return [];
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

/**
 * A free dive carries only what the bridge can supply: no effort, so no managed
 * name, gist, title, brief, meta or links. Its own id stands in for the name it
 * has not been given yet. `jump` refuses it -- no `meta.effort`, no brief -- so
 * it is a record to hang work off, not a dive anything can pick up as-is.
 */
function renderFreeDive(id: string, scopes: ScopeRef[]): string {
	return ["---", "kind: dive", `id: ${id}`, `name: ${id}`, ...renderScopes(scopes), "---", ""].join(
		"\n",
	);
}

function backlogMemoDoc(rc: NosediveRc, kbDocs: KbDoc[]): KbDoc {
	const id = rc.backlog;
	if (!id) throw new Error("record.dive --free requires a configured backlog memo id");
	if (!uuidLike(id))
		throw new Error(`record.dive --free requires a UUID-shaped backlog memo id: ${id}`);
	const doc = kbDocs.find((candidate) => candidate.id === id);
	if (!doc) throw new Error(`bridge backlog memo not found: ${id}`);
	return doc;
}

function recordFreeDive(
	rc: NosediveRc,
	kbDocs: KbDoc[],
	kbDir: string,
	workspaceDir: string,
	io: CommandIo,
): void {
	const backlog = backlogMemoDoc(rc, kbDocs);
	const scopes = backlog.scopes.map((scope) => ({
		...cachedScope(
			resolveScopeRepo(rc.bridgeDir, kbDocs, scope.repoId),
			rc.bridgeDir,
			workspaceDir,
		),
		// Stamped on after `cachedScope`, which derives the mode from the repo doc
		// and would hand back rw: an unbriefed dive nobody holds has no claim on a
		// writable checkout.
		readOnly: true,
	}));
	if (new Set(scopes.map((scope) => scope.repoId)).size !== scopes.length)
		throw new Error("duplicate repo scope");
	if (scopes.length === 0) {
		io.err(`backlog memo ${backlog.id} scopes no repos; recording a free dive with no scopes`);
	}
	const id = uuid7AtMs(Date.now());
	const path = join(kbDir, `${id}.md`);
	writeFileAtomic(path, renderFreeDive(id, scopes));
	io.log(`Recorded ${formatPath(path)}`);
	// The agent that just made the dive is the one that has to fill it in, so it
	// is told what is missing here rather than having to run preflight to find out.
	const tags = diveTags(readKbDoc(path, rc.bridgeDir), localOnlyKbDocIds(rc.bridgeDir, kbDir));
	if (tags.length > 0) io.log(`needs: ${tags.join(", ")}`);
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
	// Before the active-dive read: a free dive is never activated and never
	// claimed, so what the workspace currently holds cannot bear on it.
	if (options.free) {
		recordFreeDive(rc, kbDocs, rc.kbDir, rc.workspaceDir, io);
		return;
	}
	const active = activeDive(kbDocs, rc.workspaceDir);
	const pilotEmail = gitOutput(rc.bridgeDir, ["config", "user.email"]) ?? "";
	const workspaceDir = rc.workspaceDir;

	if (!options.ref) {
		// No guard on the active dive here: recording is writing work up, and a
		// dive nobody claims never touches the workspace marker. Claiming is the
		// part that cannot happen twice, and `ensureActivation` below is where
		// that is refused.
		const effort = resolveEffortDoc(kbDocs, rc, options.effort!);
		const scopes = options.clearScopes
			? []
			: options.scopes.length > 0
				? options.scopes.map((ref) =>
						cachedScope(resolveScopeRepo(rc.bridgeDir, kbDocs, ref), rc.bridgeDir, workspaceDir),
					)
				: inheritedScopes(effort, kbDocs).map((scope) =>
						cachedScope(
							resolveScopeRepo(rc.bridgeDir, kbDocs, scope.repoId),
							rc.bridgeDir,
							workspaceDir,
						),
					);
		if (new Set(scopes.map((scope) => scope.repoId)).size !== scopes.length)
			throw new Error("duplicate repo scope");
		// `--clear-scopes` and `--scope` both say what the pilot wants; only the
		// inherited path can come back empty without anyone having asked for it.
		if (!options.clearScopes && options.scopes.length === 0 && scopes.length === 0) {
			io.err(
				`feat ${effort.name} and its ancestors scope no repos; recording a dive with no scopes`,
			);
		}
		const id = uuid7AtMs(Date.now());
		const path = join(rc.kbDir, `${id}.md`);
		writeFileAtomic(path, renderNewDive(id, effort, options, scopes));
		reconcileDiveEffortLinks(undefined, effort, id, "planned.dive");
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
	const previousEffort = dive.effortRef ? resolveEffortDoc(kbDocs, rc, dive.effortRef) : undefined;
	const effort = options.effort ? resolveEffortDoc(kbDocs, rc, options.effort) : previousEffort;
	if (options.effort) {
		if (!effort) throw new Error(`dive ${dive.id} names no effort in meta.effort`);
		doc.set("name", managedName(effort, dive.id));
		doc.setIn(["meta", "effort"], effort.id);
	}
	if (options.gist !== undefined) doc.set("gist", options.gist.trim());
	const heldBy = dive.metaScalars.diver;
	if (options.takeover) {
		// Nothing to take over means the pilot has the wrong dive or the wrong
		// command: a free dive is claimed with --diver, and claiming is not a
		// handover anyone needs told about.
		if (!heldBy) throw new Error(`dive ${dive.id} is not held; claim it with --diver instead`);
		if (!pilotEmail) throw new Error("--takeover requires git config user.email in the bridge");
		doc.setIn(["meta", "diver"], pilotEmail);
	} else if (options.diver !== undefined) {
		if (heldBy && heldBy !== options.diver) {
			throw new Error(
				`dive ${dive.id} is held by ${heldBy}; take it over with \`record.dive --ref ${dive.id} --takeover\``,
			);
		}
		doc.setIn(["meta", "diver"], options.diver);
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
	const claimed = options.takeover ? pilotEmail : options.diver;
	if (effort) {
		// Re-homing changes the effort, not the phase. Read before reconciliation
		// removes the old effort's reciprocal link.
		const existingRel = previousEffort?.links.find((link) => link.id === dive.id)?.rel;
		reconcileDiveEffortLinks(previousEffort, effort, dive.id, existingRel ?? "planned.dive");
	}
	if (ensureActivation(dive, claimed, pilotEmail, active)) {
		writeFileAtomic(join(workspaceDir, ".nosedive-ref"), `id: ${dive.id}\n`);
	}
	io.log(`Recorded ${formatPath(dive.path)}`);
}
