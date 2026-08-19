import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import {
	cachedScope,
	editScopes,
	featWorkBranch,
	inheritedScopes,
	renderScopeEntry,
	renderScopes,
	repinScopes,
	resolveBridgeDocRef,
	resolveScopeRepo,
} from "./diveScopes.js";
import { gitOutput } from "./gitProcess.js";
import { activeDive, ensureActivation } from "./jumpSelect.js";
import { quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import {
	ensureReleasable,
	reconcileDiveFeatLinks,
	releaseDiverInFrontmatter,
	resolveFeatDoc,
} from "./repoFeatScopes.js";
import { parseRepoMarkerStrict } from "./repoWorkspaceCore.js";
import { titleFromSlug } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

export interface RecordDiveOptions {
	ref?: string;
	feat?: string;
	gist?: string;
	title?: string;
	brief?: string;
	diver?: string;
	takeover: boolean;
	/** Hand the dive back: its diver becomes its packer, and it holds nobody. */
	packer: boolean;
	free: boolean;
	clearScopes: boolean;
	/** Repos to add or make writable, each landing on `workBranch`. */
	upscopes: string[];
	/** Repos to drop from the scope set entirely. */
	unscopes: string[];
	/** The branch every `--upscope` in this call publishes to. */
	workBranch?: string;
	/** Re-resolve scope refs, changing nothing else. */
	repin: boolean;
	/** The explicit `--repin <ref>`: a git ref on origin, or a dive quid. */
	repinRef?: string;
	/** The one scope `--repin <ref>` moves. */
	scope?: string;
}

function optionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseRecordDiveArgs(args: string[]): RecordDiveOptions {
	const options: RecordDiveOptions = {
		takeover: false,
		packer: false,
		free: false,
		clearScopes: false,
		upscopes: [],
		unscopes: [],
		repin: false,
	};
	let featValue: string | undefined;
	// Holds whatever the `--effort` alias was given; the flag keeps its spelling.
	let effortValue: string | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--clear-scopes") {
			options.clearScopes = true;
			continue;
		}
		// Optionally valued: bare, every scope follows its own branch; with a ref,
		// one named scope moves. A following word that is not itself a flag is
		// that ref, which is the only reading a valueless spelling leaves room for.
		if (arg === "--repin" || arg.startsWith("--repin=")) {
			options.repin = true;
			const next = args[i + 1];
			if (arg !== "--repin") options.repinRef = arg.slice("--repin=".length);
			else if (next !== undefined && !next.startsWith("--")) {
				options.repinRef = next;
				i += 1;
			}
			if (options.repinRef !== undefined && !options.repinRef)
				throw new Error("--repin requires a value when one is given");
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
		// Valueless, like --takeover: the packer is whoever the dive already names
		// as its diver, so accepting a value would only be a way to type it wrong.
		if (arg === "--packer") {
			options.packer = true;
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
			"--upscope",
			"--unscope",
			"--work-branch",
		].find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown record.dive option: ${arg}`);
			throw new Error(`unexpected record.dive argument: ${arg}`);
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		// `--scope` is no longer a way to spell `--upscope`: it names the one scope
		// an explicit `--repin <ref>` moves, and a ref belongs to one repo.
		if (flag === "--scope") options.scope = value;
		else if (flag === "--upscope") options.upscopes.push(value);
		else if (flag === "--unscope") options.unscopes.push(value);
		else if (flag === "--work-branch") options.workBranch = value;
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
	options.feat = featValue ?? effortValue;
	// A free dive takes its every field from the bridge, so any other option can
	// only describe a dive this is not: it is checked first, and returns before
	// the rules that assume a feat-owned dive.
	if (options.free) {
		if (args.length !== 1) throw new Error("--free cannot be combined with any other option");
		return options;
	}
	const contested = options.upscopes.filter((ref) => options.unscopes.includes(ref));
	if (contested.length > 0) {
		throw new Error(`--upscope and --unscope name the same repo: ${contested.join(", ")}`);
	}
	if (options.workBranch !== undefined && options.upscopes.length === 0) {
		throw new Error("--work-branch requires at least one --upscope");
	}
	// There is no pin to move on a dive that does not exist yet: a create already
	// resolves current trunk for every scope it writes.
	if (options.repin && !options.ref) throw new Error("--repin requires --ref");
	// The two halves of an explicit repin only mean anything together: a ref
	// applied to every scope would silently pin repos it says nothing about, and
	// a named scope with no ref to put it at is a call that lost its other half.
	if (options.repinRef !== undefined && options.scope === undefined)
		throw new Error("--repin <ref> requires --scope <repo-ref>: a ref names one repo");
	if (options.scope !== undefined && options.repinRef === undefined)
		throw new Error("--scope requires --repin <ref>: it names the scope that ref moves");
	// Nothing to release on a dive that does not exist yet.
	if (options.packer && !options.ref) throw new Error("--packer requires --ref");
	if (!options.ref && !options.feat)
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

/** What a scope's branch fields become when a feat hands the repo down. */
function inheritedBranch(
	repoId: string,
	rc: NosediveRc,
	kbDocs: KbDoc[],
	feat: KbDoc | undefined,
): { workBranch?: string; readOnly: boolean } {
	const workBranch = featWorkBranch(repoId, rc, kbDocs, feat);
	return { workBranch, readOnly: !workBranch };
}

function featTitle(feat: KbDoc): string {
	const body = readFileSync(feat.path, "utf8");
	return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || titleFromSlug(feat.name.split(".")[0]!);
}

function managedName(feat: KbDoc, id: string): string {
	return `${feat.name}.${id.replaceAll("-", "").slice(-6)}`;
}

function renderNewDive(
	id: string,
	feat: KbDoc,
	options: RecordDiveOptions,
	scopes: ScopeRef[],
): string {
	const gist = options.gist?.trim() || `Working on ${featTitle(feat)}.`;
	const lines = [
		"---",
		"kind: dive",
		`id: ${id}`,
		`name: ${managedName(feat, id)}`,
		`gist: ${quoteYamlString(gist)}`,
		...renderScopes(scopes),
		"meta:",
		`  feat: ${feat.id}`,
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
 * A free dive carries only what the bridge can supply: no feat, so no managed
 * name, gist, title, brief, meta or links. Its own id stands in for the name it
 * has not been given yet. `jump` refuses it -- no `meta.feat`, no brief -- so
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
		const feat = resolveFeatDoc(kbDocs, rc, options.feat!);
		/**
		 * A new dive inherits its feat's repos, and inherits where they land only
		 * where the feat has said. A feat that has not said hands down a pinned but
		 * unpushable scope, so where the work goes stays a decision the pilot makes
		 * with `--upscope` rather than a branch nobody chose.
		 */
		const inherited = options.clearScopes
			? []
			: inheritedScopes(feat, kbDocs).scopes.map((scope) => ({
					...cachedScope(
						resolveScopeRepo(rc.bridgeDir, kbDocs, scope.repoId),
						rc.bridgeDir,
						workspaceDir,
					),
					...inheritedBranch(scope.repoId, rc, kbDocs, feat),
				}));
		const scopes = editScopes(inherited, options, rc, kbDocs, workspaceDir, feat);
		if (new Set(scopes.map((scope) => scope.repoId)).size !== scopes.length)
			throw new Error("duplicate repo scope");
		// `--clear-scopes` and `--upscope` both say what the pilot wants; only the
		// inherited path can come back empty without anyone having asked for it.
		if (!options.clearScopes && options.upscopes.length === 0 && scopes.length === 0) {
			io.err(`feat ${feat.name} and its ancestors scope no repos; recording a dive with no scopes`);
		}
		const id = uuid7AtMs(Date.now());
		const path = join(rc.kbDir, `${id}.md`);
		writeFileAtomic(path, renderNewDive(id, feat, options, scopes));
		reconcileDiveFeatLinks(undefined, feat, id, "planned.dive");
		if (ensureActivation({ id }, options.diver, pilotEmail, active))
			writeFileAtomic(join(workspaceDir, ".nosedive-ref"), `id: ${id}\n`);
		io.log(`Recorded ${formatPath(path)}`);
		return;
	}

	const dive = resolveBridgeDocRef(rc.bridgeDir, kbDocs, options.ref);
	if (dive.kind !== "dive")
		throw new Error(`--ref does not resolve to a kind: dive doc: ${options.ref}`);
	// Before anything is read off the document, so a refused release leaves it as
	// it stands rather than partway through an edit. A repin is not gated here:
	// it moves no worktree, so which dive the workspace is on decides nothing,
	// and what it can strand is checked per scope against that scope's worktree.
	if (options.packer) ensureReleasable(dive, pilotEmail, active);
	const text = readFileSync(dive.path, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(dive.path));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0)
		throw new Error(`invalid YAML in frontmatter in ${formatPath(dive.path)}`);
	const previousFeat = dive.featRef ? resolveFeatDoc(kbDocs, rc, dive.featRef) : undefined;
	const feat = options.feat ? resolveFeatDoc(kbDocs, rc, options.feat) : previousFeat;
	if (options.feat) {
		if (!feat) throw new Error(`dive ${dive.id} names no feat in meta.feat`);
		doc.set("name", managedName(feat, dive.id));
		doc.setIn(["meta", "feat"], feat.id);
		// Not a migration -- the one case where leaving the old key would make the
		// document name two different feats, with the parser silently preferring
		// one of them.
		doc.deleteIn(["meta", "effort"]);
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
	if (options.packer) releaseDiverInFrontmatter(doc);
	/**
	 * Gaining a feat for the first time is when a dive learns where its repos
	 * land, the same way a dive created under one does. Re-homing an already-owned
	 * dive leaves its branches alone: they may have been chosen by hand, and the
	 * new feat's opinion does not outrank the pilot's.
	 */
	const adopting = options.feat !== undefined && previousFeat === undefined;
	const inheritedNow = adopting
		? dive.scopes.map((scope) =>
				scope.workBranch ? scope : { ...scope, ...inheritedBranch(scope.repoId, rc, kbDocs, feat) },
			)
		: dive.scopes;
	if (
		adopting ||
		options.repin ||
		options.clearScopes ||
		options.upscopes.length > 0 ||
		options.unscopes.length > 0
	) {
		const base = options.clearScopes ? [] : inheritedNow;
		const edited = editScopes(base, options, rc, kbDocs, workspaceDir, feat);
		// Last, so a repo added in the same call is pinned at trunk like the rest.
		const scopes = options.repin
			? repinScopes(edited, rc, kbDocs, workspaceDir, feat, io, {
					ref: options.repinRef,
					scope: options.scope,
				})
			: edited;
		if (new Set(scopes.map((scope) => scope.repoId)).size !== scopes.length)
			throw new Error("duplicate repo scope");
		doc.set("scopes", scopes.map(renderScopeEntry));
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
	if (feat) {
		// Re-homing changes the feat, not the phase. Read before reconciliation
		// removes the old feat's reciprocal link.
		const existingRel = previousFeat?.links.find((link) => link.id === dive.id)?.rel;
		reconcileDiveFeatLinks(previousFeat, feat, dive.id, existingRel ?? "planned.dive");
	}
	if (ensureActivation(dive, claimed, pilotEmail, active)) {
		writeFileAtomic(join(workspaceDir, ".nosedive-ref"), `id: ${dive.id}\n`);
	}
	io.log(`Recorded ${formatPath(dive.path)}`);
}
