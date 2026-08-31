import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

import { CommandIo } from "./bridgeSetupIo.js";
import { commitBridgeDocs } from "./commitBridgeDocs.js";
import {
	formatPath,
	NosediveRc,
	parseMarkdownDoc,
	readNosediveRc,
	stringifyYaml,
} from "./coreParsing.js";
import { resolveBridgeDocRef, resolveScopeRepo } from "./diveScopes.js";
import { KbDoc, loadKbDocs, retitleGeneratedHeading } from "./kbDocs.js";
import { resolveGateScript } from "./landGates.js";
import { LinkRef } from "./kbRefs.js";
import { bridgeDocRefPredicate, positionalGistNotice } from "./recordArgs.js";
import { quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import { appendLinkToDoc, reconcileDocLink, resolveFeatDoc } from "./repoFeatScopes.js";
import { assertSlug, slugFromGist, titleFromSlug } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

export interface RecordGateOptions {
	/** The gate to patch. Absent means mint a new one. */
	ref?: string;
	gist?: string;
	feat?: string;
	repo?: string;
	name?: string;
	/** `gate-height` on the declaring link; taller gates run first. */
	height?: number;
	/** `test-is-flaky` on the declaring link; a flaky gate reports but never blocks. */
	flaky?: boolean;
	/** `note` on the declaring link; null means remove it. */
	note?: string | null;
	/** Which rel the declaring link carries: `test.gate` or `land.gate`. */
	action?: "test" | "land";
	/** The gist arrived as a positional, in the spelling this level deprecates. */
	positionalGist: boolean;
}

function optionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseRecordGateArgs(
	args: string[],
	isDocRef: (arg: string) => boolean,
): RecordGateOptions {
	const options: RecordGateOptions = { positionalGist: false };

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		// Two spellings because the flag is the only way to say either answer: a
		// gate that could be marked flaky but never unmarked is a one-way door.
		if (arg === "--flaky" || arg === "--no-flaky") {
			options.flaky = arg === "--flaky";
			continue;
		}
		if (arg === "--no-note") {
			options.note = null;
			continue;
		}
		const flag = ["--gist", "--feat", "--repo", "--name", "--height", "--action", "--note"].find(
			(candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
		);
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown record.gate option: ${arg}`);
			if (isDocRef(arg)) {
				if (options.ref !== undefined) throw new Error(`unexpected record.gate argument: ${arg}`);
				options.ref = arg;
			} else {
				if (options.gist !== undefined) throw new Error(`record.gate gist given twice: ${arg}`);
				options.gist = arg;
				options.positionalGist = true;
			}
			continue;
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		if (flag === "--gist") {
			if (options.gist !== undefined) throw new Error("record.gate gist given twice");
			options.gist = value;
		} else if (flag === "--feat") options.feat = value;
		else if (flag === "--repo") options.repo = value;
		else if (flag === "--name") options.name = assertSlug(value, "--name");
		else if (flag === "--note") options.note = value;
		else if (flag === "--action") {
			if (value !== "test" && value !== "land")
				throw new Error(`--action must be test or land: ${value}`);
			options.action = value;
		} else {
			if (!/^-?\d+$/.test(value.trim())) throw new Error(`--height must be an integer: ${value}`);
			options.height = Number.parseInt(value.trim(), 10);
		}
	}

	if (options.gist !== undefined) {
		options.gist = options.gist.trim();
		if (!options.gist) throw new Error("gist cannot be empty");
	}
	if (typeof options.note === "string") {
		options.note = options.note.trim();
		if (!options.note) throw new Error("note cannot be empty");
	}
	if (options.feat && options.repo)
		throw new Error("--feat and --repo are mutually exclusive; name one declaring document");
	if (options.repo && options.action === "test") {
		throw new Error(
			"--repo cannot declare test.gate: a repo cannot regress without a feat in context, so a failing repo-declared test.gate would have no document to mint work against",
		);
	}
	if (options.ref === undefined) {
		if (options.gist === undefined) throw new Error('record.gate requires --gist "<one line>"');
		if (!options.feat && !options.repo) throw new Error("record.gate requires --feat or --repo");
	}
	return options;
}

/**
 * The same shape and the same reason as a recorded feat's default name: a gate
 * can be minted before anybody has a good name for it, and renamed later.
 */
export function defaultGateName(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return [
		"new-gate",
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
		`${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
	].join("-");
}

/**
 * A feat-declared gate writes no `scopes:` key and inherits its feat's scopes.
 * A repo-declared gate names that repo itself: repo docs normally have no
 * scopes to inherit, while the gate's `ctx.repos` must contain its repo.
 */
function renderGateDoc(
	id: string,
	name: string,
	gist: string,
	scriptRel: string,
	repoId?: string,
): string {
	return [
		"---",
		"kind: gate",
		`id: ${id}`,
		`name: ${name}`,
		`gist: ${quoteYamlString(gist)}`,
		...(repoId ? ["scopes:", `  - ${repoId}`] : []),
		"meta:",
		`  test-script: ${scriptRel}`,
		"---",
		"",
		`# ${titleFromSlug(name)}`,
		"",
	].join("\n");
}

/**
 * The stub fails, and that is the whole point of writing one. A gate that
 * returns cleanly reports green having checked nothing, which is the failure
 * this command exists to prevent -- so an unwritten gate is a red gate, and the
 * pilot is told where to write it.
 *
 * `false` rather than `process.exit(1)`: the runner maps a `false` return to
 * exit 1, and exiting on the spot would cut off output the runner is still
 * draining.
 */
function renderGateStub(scriptRel: string): string {
	return `export async function run(ctx) {
	/**
	 * Minted by \`nosedive record.gate\` and deliberately failing. Replace this body
	 * with the check itself: return false (or throw) when what it proves does not
	 * hold, and return anything else when it does.
	 */
	console.error(\`ctx: \${JSON.stringify(ctx, null, 2)}\`);
	console.error(\`gate \${ctx.gateId} is unimplemented -- write the check in ${scriptRel}\`);
	return false;
}
`;
}

/**
 * The attributes the declaring link should carry after this call. Attributes
 * the command knows nothing about are carried through: they were written by
 * somebody, and a height change is no reason to drop them.
 */
function gateLinkAttrs(
	previous: Record<string, string> | undefined,
	options: RecordGateOptions,
): Record<string, string | number | boolean> {
	const attrs: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(previous ?? {})) {
		if (key === "rel") continue;
		if (key === "gate-height") attrs[key] = Number(value);
		else if (key === "test-is-flaky") attrs[key] = value === "true";
		else attrs[key] = value;
	}
	if (options.height !== undefined) attrs["gate-height"] = options.height;
	if (options.flaky === true) attrs["test-is-flaky"] = true;
	if (options.flaky === false) delete attrs["test-is-flaky"];
	if (typeof options.note === "string") attrs.note = options.note;
	if (options.note === null) delete attrs.note;
	return attrs;
}

function featForGate(kbDocs: KbDoc[], rc: NosediveRc, featRef: string): KbDoc {
	const feat = resolveFeatDoc(kbDocs, rc, featRef);
	// `mintFailedBacklogGates` hangs work off the feat that declared a failing
	// gate, so declaring one anywhere else leaves that failure with nowhere to go.
	if (feat.kind !== "feat")
		throw new Error(`--feat does not resolve to a kind: feat doc: ${featRef}`);
	return feat;
}

function declaringDoc(kbDocs: KbDoc[], gateId: string): { doc: KbDoc; link: LinkRef } | undefined {
	for (const doc of kbDocs.filter(
		(candidate) => candidate.kind === "feat" || candidate.kind === "repo",
	)) {
		const link = doc.links.find(
			(candidate) =>
				candidate.id === gateId && (candidate.rel === "test.gate" || candidate.rel === "land.gate"),
		);
		if (link) return { doc, link };
	}
	return undefined;
}

function createGate(rc: NosediveRc, kbDocs: KbDoc[], options: RecordGateOptions, io: CommandIo) {
	const gist = options.gist!;
	const declaring = options.repo
		? resolveScopeRepo(rc.bridgeDir, kbDocs, options.repo)
		: featForGate(kbDocs, rc, options.feat!);
	const action = options.repo ? "land" : (options.action ?? "test");

	const id = uuid7AtMs(Date.now());
	// An explicit --name wins outright. Otherwise derive a slug from the gist,
	// so the first thing a pilot sees named is what the gate checks rather than
	// a clock -- but fall back to the timestamp name if the derived slug
	// collides with a gate already declared on this doc, or the gist yields
	// nothing usable, rather than refusing to mint a runnable gate at all.
	const existingGateNames = new Set(
		declaring.links
			.filter((link) => link.rel === "test.gate" || link.rel === "land.gate")
			.map((link) => kbDocs.find((doc) => doc.id === link.id)?.name)
			.filter((docName): docName is string => docName !== undefined),
	);
	const derived = slugFromGist(gist);
	const name =
		options.name ?? (derived && !existingGateNames.has(derived) ? derived : defaultGateName());
	const docPath = join(rc.kbDir!, `${id}.md`);
	const scriptRel = `kb/artifacts/${id}.mjs`;
	const scriptPath = join(rc.kbDir!, "artifacts", `${id}.mjs`);
	if (existsSync(docPath)) throw new Error(`kb doc already exists: ${formatPath(docPath)}`);

	// The doc and the script are one thing: `resolveGateScript` hard-fails a gate
	// whose script does not resolve, so a command that minted only the doc would
	// produce something that breaks the moment anything selects it.
	mkdirSync(join(rc.kbDir!, "artifacts"), { recursive: true });
	writeFileAtomic(scriptPath, renderGateStub(scriptRel));
	writeFileAtomic(
		docPath,
		renderGateDoc(id, name, gist, scriptRel, options.repo ? declaring.id : undefined),
	);
	appendLinkToDoc(declaring.path, id, `${action}.gate`, gateLinkAttrs(undefined, options));

	io.log(`Recorded ${formatPath(docPath)}`);
	io.log(`Wrote ${formatPath(scriptPath)}`);
	io.log(`Declared ${action}.gate on ${formatPath(declaring.path)}`);
	commitBridgeDocs(
		rc.bridgeDir,
		`gate(${name}): created`,
		[docPath, scriptPath, declaring.path],
		io,
		declaring.kind === "feat" ? declaring.id : undefined,
	);
	if (action === "land") io.log("It blocks nosedive land until it passes.");
	io.log(`It fails until written. Run it with: nosedive test ${id}`);
}

function editGate(rc: NosediveRc, kbDocs: KbDoc[], options: RecordGateOptions, io: CommandIo) {
	const gate = resolveBridgeDocRef(rc.bridgeDir, kbDocs, options.ref!);
	// A resolvable script, not a kind. `test` and `land` select a gate by a
	// `.gate` rel and a script that resolves, deliberately, so an assertion doc a
	// feat declares as a gate is one. Insisting on `kind: gate` here would leave
	// land's dirty-gate refusal naming a command that cannot run on half the
	// gates a bridge has.
	const scriptPath = resolveGateScript(gate, rc.bridgeDir);

	if (options.gist !== undefined || options.name !== undefined) {
		const text = readFileSync(gate.path, "utf8");
		const parsed = parseMarkdownDoc(text, formatPath(gate.path));
		const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
		if (doc.errors.length > 0)
			throw new Error(`invalid YAML in frontmatter in ${formatPath(gate.path)}`);
		if (options.gist !== undefined) doc.set("gist", options.gist);
		const body =
			options.name === undefined
				? parsed.body
				: retitleGeneratedHeading(parsed.body, gate.name, options.name);
		if (options.name !== undefined) doc.set("name", options.name);
		writeFileAtomic(gate.path, ["---", stringifyYaml(doc).trimEnd(), "---", body].join("\n"));
	}

	const declared = declaringDoc(kbDocs, gate.id);
	const declaration = options.feat
		? featForGate(kbDocs, rc, options.feat)
		: options.repo
			? resolveScopeRepo(rc.bridgeDir, kbDocs, options.repo)
			: declared?.doc;
	if (declaration?.kind === "repo" && options.action === "test") {
		throw new Error(
			"a repo cannot regress without a feat in context, so a failing repo-declared test.gate would have no document to mint work against",
		);
	}
	const redeclaring =
		options.feat !== undefined ||
		options.repo !== undefined ||
		options.action !== undefined ||
		options.height !== undefined ||
		options.flaky !== undefined ||
		options.note !== undefined;
	if (redeclaring) {
		// Height, flakiness and action all live on the link rather than the doc, so
		// there is nowhere to put them until a feat or repo declares the gate.
		if (!declaration) {
			throw new Error(
				`gate ${gate.name} is declared on no feat or repo; name one with --feat <feat-ref> or --repo <repo-ref>`,
			);
		}
		const action =
			declaration.kind === "repo"
				? "land"
				: (options.action ?? (declared?.link.rel === "land.gate" ? "land" : "test"));
		const rel = `${action}.gate`;
		if (declared && declared.doc.id !== declaration.id)
			reconcileDocLink(declared.doc.path, gate.id, undefined);
		reconcileDocLink(declaration.path, gate.id, rel, gateLinkAttrs(declared?.link.attrs, options));
		io.log(`Declared ${rel} on ${formatPath(declaration.path)}`);
	}

	const name = options.name ?? gate.name;
	// The script, not just the doc. A pilot writes the check by hand in the file
	// the stub named, and every other command stashes it around a push, so a gate
	// whose script never went in publishes as the stub it was minted as.
	const committed = commitBridgeDocs(
		rc.bridgeDir,
		`gate(${name}): updated`,
		[gate.path, scriptPath, declaration?.path, declared?.doc.path],
		io,
		declaration?.kind === "feat" ? declaration.id : undefined,
	);
	// After the commit, because "updated" is a claim about what was published.
	io.log(
		committed ? `Updated ${formatPath(gate.path)}` : `Already published: ${formatPath(gate.path)}`,
	);
}

export function recordGate(args: string[], io: CommandIo): void {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("record.gate requires a configured kb directory");
	// Before the parse, because whether the positional is a document is a
	// question only the bridge can answer.
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const options = parseRecordGateArgs(args, bridgeDocRefPredicate(rc.bridgeDir, kbDocs));
	if (options.positionalGist) io.err(positionalGistNotice("record.gate"));
	if (options.ref === undefined) createGate(rc, kbDocs, options, io);
	else editGate(rc, kbDocs, options, io);
}
