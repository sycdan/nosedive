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
	ensureReleasable,
	reconcileDiveFeatLinks,
	releaseDiverInFrontmatter,
	resolveFeatDoc,
} from "./repoFeatScopes.js";
import { parseRepoMarkerStrict } from "./repoWorkspaceCore.js";
import { managedDiveName, titleFromSlug } from "./slugs.js";
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

function featTitle(feat: KbDoc): string {
	const body = readFileSync(feat.path, "utf8");
	return /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || titleFromSlug(feat.name.split(".")[0]!);
}

function managedName(feat: KbDoc, id: string): string {
	return managedDiveName(feat.name, id);
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
	const recorded = readKbDoc(path, rc.bridgeDir);
	commitBridgeDocs(rc.bridgeDir, `dive(${recorded.name}): created`, [path], io);
	const tags = diveTags(recorded, localOnlyKbDocIds(rc.bridgeDir, kbDir));
	if (tags.length > 0) io.log(`needs: ${tags.join(", ")}`);
	printNextSteps(io, [`nosedive jump kb/${id}.md`]);
}

function replaceTitle(body: string, title: string): string {
	if (/^#\s+.*$/m.test(body)) return body.replace(/^#\s+.*$/m, `# ${title}`);
	return `# ${title}\n\n${body}`;
}

export function recordDive(args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("record.dive requires a configured kb directory");
	if (!rc.workspaceDir) throw new Error("record.dive requires a configured workspace directory");
	// Before the parse, because whether the positional is a document is a
	// question only the bridge can answer.
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const options = parseRecordDiveArgs(args, bridgeDocRefPredicate(rc.bridgeDir, kbDocs));
	// Before the active-dive read: a free dive is never activated and never
	// claimed, so what the workspace currently holds cannot bear on it.
	if (options.free) {
		recordFreeDive(rc, kbDocs, rc.kbDir, rc.workspaceDir, io);
		return;
	}
	const active = activeDive(kbDocs, rc.workspaceDir);
	const pilotEmail = readGitAuthorIdentity(rc.bridgeDir).email;
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
		commitBridgeDocs(
			rc.bridgeDir,
			`dive(${readKbDoc(path, rc.bridgeDir).name}): created`,
			[path, feat.path],
			io,
			feat.id,
		);
		printNextSteps(io, [`nosedive jump kb/${id}.md`]);
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
	commitBridgeDocs(
		rc.bridgeDir,
		`dive(${dive.name}): updated`,
		[dive.path, feat?.path, previousFeat?.path],
		io,
		feat?.id,
	);
	printNextSteps(io, [`nosedive jump kb/${dive.id}.md`]);
}
