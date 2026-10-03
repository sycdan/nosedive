import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";

import { diveTags, localOnlyKbDocIds } from "./diveListing.js";
import { CommandIo } from "./bridgeSetupIo.js";
import { DIVE_BRIEF_HEADING, DIVE_BRIEF_HEADING_PATTERN } from "./constants.js";
import { readStdinText } from "./stdinText.js";
import {
	defaultWorkBranch,
	formatPath,
	NosediveRc,
	parseMarkdownDoc,
	readNosediveRc,
	stringifyYaml,
	uuidLike,
} from "./coreParsing.js";
import { KbDoc, ScopeRef, loadKbDocs, readActiveDiveId, readKbDoc } from "./kbDocs.js";
import {
	cachedScope,
	editScopes,
	featWorkBranch,
	inheritedScopes,
	pinnedScope,
	renderScopeEntry,
	renderScopes,
	repinScopes,
	resolveBridgeDocRef,
	resolveScopeRepo,
} from "./diveScopes.js";
import { activeDive, ensureActivation } from "./jumpSelect.js";
import { readGitAuthorIdentity } from "./gitProcess.js";
import { commitBridgeDocs } from "./commitBridgeDocs.js";
import { bridgeDocRefPredicate } from "./recordArgs.js";
import { parseRecordDiveArgs, type RecordDiveOptions } from "./recordDiveArgs.js";
import { printNextSteps } from "./nextSteps.js";
import { quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import {
	bridgeFeatPath,
	ensureReleasable,
	featRefOf,
	linkFeatBack,
	reconcileDiveFeatLinks,
	releaseDiverInFrontmatter,
	resolveFeatDoc,
} from "./repoFeatScopes.js";
import { parseRepoMarkerStrict } from "./repoWorkspaceCore.js";
import { managedDiveName, titleFromSlug } from "./slugs.js";
import { KB_FEAT_ID } from "./shipZerostars.js";
import { uuid7AtMs } from "./uuid7.js";

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

/**
 * Every new dive scopes the bridge, because planning writes to the bridge kb
 * and a dive whose feat scopes only another repo could not plan otherwise.
 *
 * The scope is what a feat scoping the bridge would hand down. A feat that says
 * nothing about the bridge gets the branch the kb feat's bridge scope names, so
 * kb changes land exactly as they do on a kb-feat dive; failing that, the
 * branch seed gives the kb feat. `--clear-scopes` does not drop it -- the bridge
 * is always in scope -- but an explicit `--unscope` of the bridge does.
 */
function withBridgeScope(
	scopes: ScopeRef[],
	unscopes: string[],
	rc: NosediveRc,
	kbDocs: KbDoc[],
	workspaceDir: string,
	feat: KbDoc,
): ScopeRef[] {
	const bridgeId = rc.bridge;
	const repo = bridgeId
		? kbDocs.find((doc) => doc.id === bridgeId && doc.kind === "repo")
		: undefined;
	if (!repo || scopes.some((scope) => scope.repoId === repo.id)) return scopes;
	if (unscopes.some((ref) => resolveScopeRepo(rc.bridgeDir, kbDocs, ref).id === repo.id))
		return scopes;
	const kbFeat = kbDocs.find((doc) => doc.id === KB_FEAT_ID);
	const workBranch =
		inheritedBranch(repo.id, rc, kbDocs, feat).workBranch ??
		featWorkBranch(repo.id, rc, kbDocs, kbFeat) ??
		defaultWorkBranch(rc, "kb");
	return [
		...scopes,
		{
			...pinnedScope(repo, rc.bridgeDir, workspaceDir, workBranch),
			workBranch,
			readOnly: false,
		},
	];
}

/** A feat in another repo takes a link back, so it has to be read from a checkout. */
function writableFeat(feat: KbDoc): KbDoc {
	if (feat.home && !feat.home.checkout)
		throw new Error(
			`feat ${feat.name} lives in a repo that is not hydrated, so it cannot take a link back; ` +
				`hydrate it first: nosedive hydrate-repo.workspace ${feat.home.repoId}`,
		);
	return feat;
}

function featTitle(feat: KbDoc): string {
	const body = readFileSync(feat.path, "utf8");
	return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || titleFromSlug(feat.name.split(".")[0]!);
}

function managedName(feat: KbDoc, id: string): string {
	return managedDiveName(feat.name, id);
}

/** Any `##` section, which below the brief means work the brief already directed. */
const SECTION_HEADING = /^##\s/;

function readDiveBrief(): string {
	const brief = readStdinText(
		"record.dive reads the brief on stdin: `nosedive record.dive --feat <feat> --brief - < brief.md`",
	);
	if (!brief) throw new Error("brief cannot be empty");
	return brief;
}

function renderNewDive(
	id: string,
	feat: KbDoc,
	options: RecordDiveOptions,
	scopes: ScopeRef[],
	brief: string | undefined,
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
		`  feat: ${featRefOf(feat)}`,
		`  diver: ${options.diver ? quoteYamlString(options.diver) : "null"}`,
		"---",
		"",
		`# ${options.title?.trim() || "Dive Record"}`,
	];
	if (brief) lines.push("", DIVE_BRIEF_HEADING, "", brief);
	lines.push("");
	return lines.join("\n");
}

/**
 * A free dive carries only what the bridge can supply: no feat, so no managed
 * name, gist, title, brief or links. Its own id stands in for the name it has
 * not been given yet. `jump` refuses it -- no `meta.feat` -- so it is a record
 * to hang work off, not a dive anything can pick up as-is.
 *
 * It is claimed all the same. Finding work is work: it reads the workspace and
 * may hydrate into it, so the marker has to say what the checkouts are for, and
 * `append-log.dive` and `bail` both read that marker.
 */
function renderFreeDive(id: string, scopes: ScopeRef[], diver: string): string {
	return [
		"---",
		"kind: dive",
		`id: ${id}`,
		`name: ${id}`,
		...renderScopes(scopes),
		"meta:",
		`  diver: ${quoteYamlString(diver)}`,
		"---",
		"",
	].join("\n");
}

function freeDiveNextSteps(id: string, gist: string): string[] {
	const steps = gist
		? []
		: [`nosedive record.dive ${id} --gist "<the question>" -- name what is being looked into`];
	return [
		...steps,
		"nosedive append-log.dive -- record what you find, body on stdin",
		`nosedive record.dive ${id} --feat <feat-ref> -- assign a feat, making it jumpable`,
		`nosedive bail --reason "<what you found>" -- close it as a memo`,
	];
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
	pilotEmail: string,
	active: KbDoc | undefined,
	io: CommandIo,
): void {
	// A dive nobody can be named as holding is not claimable, and an unclaimed
	// free dive is one no other command will act on.
	if (!pilotEmail)
		throw new Error("record.dive --free requires git config user.email in the bridge");
	const backlog = backlogMemoDoc(rc, kbDocs);
	const scopes = backlog.scopes.map((scope) => ({
		...cachedScope(
			resolveScopeRepo(rc.bridgeDir, kbDocs, scope.repoId),
			rc.bridgeDir,
			workspaceDir,
		),
		// Stamped on after `cachedScope`, which derives the mode from the repo doc
		// and would hand back rw: a free dive answers a question, and what it
		// produces is a memo. Code lands on the feat-owned dive it leads to.
		readOnly: true,
	}));
	if (new Set(scopes.map((scope) => scope.repoId)).size !== scopes.length)
		throw new Error("duplicate repo scope");
	if (scopes.length === 0) {
		io.err(`backlog memo ${backlog.id} scopes no repos; recording a free dive with no scopes`);
	}
	const id = uuid7AtMs(Date.now());
	const path = join(kbDir, `${id}.md`);
	// Before the document exists, so a workspace flying something else costs
	// nothing: `ensureActivation` throws here rather than leaving a claimed dive
	// on disk that the marker never named.
	ensureActivation({ id }, pilotEmail, pilotEmail, active);
	writeFileAtomic(path, renderFreeDive(id, scopes, pilotEmail));
	writeFileAtomic(join(workspaceDir, ".nosedive-ref"), `id: ${id}\n`);
	io.log(`Recorded ${formatPath(path)}`);
	// The agent that just made the dive is the one that has to fill it in, so it
	// is told what is missing here rather than having to run preflight to find out.
	const recorded = readKbDoc(path, rc.bridgeDir);
	commitBridgeDocs(rc.bridgeDir, `dive(${recorded.name}): created`, [path], io);
	const tags = diveTags(recorded, localOnlyKbDocIds(rc.bridgeDir, kbDir));
	if (tags.length > 0) io.log(`needs: ${tags.join(", ")}`);
	printNextSteps(io, freeDiveNextSteps(id, ""));
}

function replaceTitle(body: string, title: string): string {
	if (/^#\s+.*$/m.test(body)) return body.replace(/^#\s+.*$/m, `# ${title}`);
	return `# ${title}\n\n${body}`;
}

/** Where `crud dive` has a new dive written: the kb the dive kind resolved from. */
export interface DiveTarget {
	root: string;
	kbDir: string;
}

/** What an in-process caller hands `recordDive` beyond the CLI's own arguments. */
export interface RecordDiveExtras {
	/**
	 * For the caller that already holds the text -- `test` minting a dive for a
	 * failed gate. Every other caller is the CLI, where the brief arrives on
	 * stdin because an argument cannot carry paragraphs.
	 */
	brief?: string;
	/** `jump <feat>` mints the id first, to title the dive with the name it derives. */
	newId?: string;
	/**
	 * Writes and commits a new dive in another checkout of the bridge -- a
	 * dive's `__self` -- while its scopes still resolve against the live bridge
	 * and workspace. Such a dive is recorded, never claimed.
	 */
	target?: DiveTarget;
}

export function recordDive(args: string[], io: CommandIo, extras: RecordDiveExtras = {}): void {
	const { newId, target } = extras;
	let brief = extras.brief;
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("record.dive requires a configured kb directory");
	if (!rc.workspaceDir) throw new Error("record.dive requires a configured workspace directory");
	const docRoot = target?.root ?? rc.bridgeDir;
	const kbDir = target?.kbDir ?? rc.kbDir;
	// Before the parse, because whether the positional is a document is a
	// question only the bridge can answer.
	const kbDocs = loadKbDocs(kbDir, docRoot);
	const options = parseRecordDiveArgs(args, bridgeDocRefPredicate(docRoot, kbDocs));
	if (options.briefStdin) brief = readDiveBrief();
	if (target && (options.ref || options.free || options.diver))
		throw new Error("a dive recorded elsewhere is only created, never claimed");
	const active = target ? undefined : activeDive(kbDocs, rc.workspaceDir);
	const pilotEmail = readGitAuthorIdentity(rc.bridgeDir).email;
	const workspaceDir = rc.workspaceDir;
	// The dive in flight, whose checkout of a feat's repo commits the feat's link back.
	const activeId = readActiveDiveId(workspaceDir);
	const scoping = kbDocs.find((doc) => doc.kind === "dive" && doc.id === activeId);

	// After the active-dive read, not before it: a free dive claims the workspace
	// like any other, so one already in flight is what refuses this one.
	if (options.free) {
		recordFreeDive(rc, kbDocs, rc.kbDir, workspaceDir, pilotEmail, active, io);
		return;
	}

	if (!options.ref) {
		// No guard on the active dive here: recording is writing work up, and a
		// dive nobody claims never touches the workspace marker. Claiming is the
		// part that cannot happen twice, and `ensureActivation` below is where
		// that is refused.
		const feat = writableFeat(resolveFeatDoc(kbDocs, rc, options.feat!));
		/**
		 * A new dive inherits its feat's repos, and inherits where they land only
		 * where the feat has said. A feat that has not said hands down a pinned but
		 * unpushable scope, so where the work goes stays a decision the pilot makes
		 * with `--upscope` rather than a branch nobody chose.
		 *
		 * The pin follows that branch: a dive recorded after a sibling landed starts
		 * on top of what the sibling published rather than behind it. A feat with no
		 * branch for the repo, and the first dive on one that has yet to publish,
		 * both start at trunk.
		 */
		const inherited = options.clearScopes
			? []
			: inheritedScopes(feat, kbDocs).scopes.map((scope) => {
					const branch = inheritedBranch(scope.repoId, rc, kbDocs, feat);
					return {
						...pinnedScope(
							resolveScopeRepo(rc.bridgeDir, kbDocs, scope.repoId),
							rc.bridgeDir,
							workspaceDir,
							branch.workBranch,
						),
						...branch,
					};
				});
		const edited = editScopes(inherited, options, rc, kbDocs, workspaceDir, feat);
		// `--clear-scopes` and `--upscope` both say what the pilot wants; only the
		// inherited path can come back empty without anyone having asked for it.
		// Read before the bridge is added: the feat still scopes nothing.
		if (!options.clearScopes && options.upscopes.length === 0 && edited.length === 0) {
			io.err(`feat ${feat.name} and its ancestors scope no repos; recording a dive with no scopes`);
		}
		const scopes = withBridgeScope(edited, options.unscopes, rc, kbDocs, workspaceDir, feat);
		if (new Set(scopes.map((scope) => scope.repoId)).size !== scopes.length)
			throw new Error("duplicate repo scope");
		const id = newId ?? uuid7AtMs(Date.now());
		const path = join(kbDir, `${id}.md`);
		writeFileAtomic(path, renderNewDive(id, feat, options, scopes, brief));
		reconcileDiveFeatLinks(undefined, feat, id, "planned.dive");
		linkFeatBack(feat, id, "planned.dive", scoping, io);
		if (ensureActivation({ id }, options.diver, pilotEmail, active))
			writeFileAtomic(join(workspaceDir, ".nosedive-ref"), `id: ${id}\n`);
		io.log(`Recorded ${formatPath(path)}`);
		commitBridgeDocs(
			docRoot,
			`dive(${readKbDoc(path, docRoot).name}): created`,
			[path, bridgeFeatPath(feat)],
			io,
			feat.id,
		);
		printNextSteps(
			io,
			docRoot === rc.bridgeDir
				? [`nosedive jump kb/${id}.md`]
				: ["nosedive land -- publish it to the bridge, to be jumped from there"],
		);
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
	const feat = options.feat ? writableFeat(resolveFeatDoc(kbDocs, rc, options.feat)) : previousFeat;
	if (options.feat) {
		if (!feat) throw new Error(`dive ${dive.id} names no feat in meta.feat`);
		doc.set("name", managedName(feat, dive.id));
		doc.setIn(["meta", "feat"], featRefOf(feat));
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
	if (brief) {
		const lines = body.split("\n");
		const start = lines.findIndex((line) => DIVE_BRIEF_HEADING_PATTERN.test(line));
		// Write-once, but only once the brief has informed something. Every section
		// below it was written by work it directed, so replacing it then would make
		// the record lie. A dive whose brief is still the last thing in it has
		// directed nothing -- nobody has jumped it -- and rewriting that one is a
		// pitch being corrected rather than history being edited.
		if (start !== -1 && lines.slice(start + 1).some((line) => SECTION_HEADING.test(line))) {
			throw new Error(
				`dive already has a brief: ${formatPath(dive.path)}; bail and pitch a new dive instead of rewriting it`,
			);
		}
		const head = start === -1 ? body : lines.slice(0, start).join("\n");
		body = `${head.trimEnd()}\n\n${DIVE_BRIEF_HEADING}\n\n${brief}\n`;
	}
	writeFileAtomic(dive.path, ["---", stringifyYaml(doc).trimEnd(), "---", body].join("\n"));
	const claimed = options.takeover ? pilotEmail : options.diver;
	if (feat) {
		// Re-homing changes the feat, not the phase. Read before reconciliation
		// removes the old feat's reciprocal link.
		const existingRel = previousFeat?.links.find((link) => link.id === dive.id)?.rel;
		reconcileDiveFeatLinks(previousFeat, feat, dive.id, existingRel ?? "planned.dive");
		linkFeatBack(feat, dive.id, existingRel ?? "planned.dive", scoping, io);
	}
	if (ensureActivation(dive, claimed, pilotEmail, active)) {
		writeFileAtomic(join(workspaceDir, ".nosedive-ref"), `id: ${dive.id}\n`);
	}
	io.log(`Recorded ${formatPath(dive.path)}`);
	commitBridgeDocs(
		rc.bridgeDir,
		`dive(${dive.name}): updated`,
		[dive.path, bridgeFeatPath(feat), bridgeFeatPath(previousFeat)],
		io,
		feat?.id,
	);
	// A dive with no feat is a free dive whatever else this call changed about
	// it, and `jump` is not among the things it can do next.
	printNextSteps(
		io,
		feat
			? [`nosedive jump kb/${dive.id}.md`]
			: freeDiveNextSteps(dive.id, options.gist?.trim() ?? dive.gist),
	);
}
