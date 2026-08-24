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
import { resolveBridgeDocRef } from "./diveScopes.js";
import { KbDoc, loadKbDocs, retitleGeneratedHeading } from "./kbDocs.js";
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
	name?: string;
	/** `gate-height` on the declaring link; taller gates run first. */
	height?: number;
	/** `test-is-flaky` on the declaring link; a flaky gate reports but never blocks. */
	flaky?: boolean;
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
		const flag = ["--gist", "--feat", "--name", "--height", "--action"].find(
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
		else if (flag === "--name") options.name = assertSlug(value, "--name");
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
	if (options.ref === undefined) {
		if (options.gist === undefined) throw new Error('record.gate requires --gist "<one line>"');
		// A gate has to be declared where a feat is in context, or a failing
		// backlog sweep has nothing to mint work against.
		if (!options.feat) throw new Error("record.gate requires --feat");
	} else if (
		options.gist === undefined &&
		options.feat === undefined &&
		options.name === undefined &&
		options.height === undefined &&
		options.flaky === undefined &&
		options.action === undefined
	) {
		throw new Error(`record.gate ${options.ref} names a gate but changes nothing about it`);
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
 * No `scopes:` key at all. An absent one inherits the declaring doc's scopes,
 * which is what a new gate wants; an explicit `scopes: []` would say the
 * opposite -- this gate needs no repo -- and pin it to nothing.
 */
function renderGateDoc(id: string, name: string, gist: string, scriptRel: string): string {
	return [
		"---",
		"kind: gate",
		`id: ${id}`,
		`name: ${name}`,
		`gist: ${quoteYamlString(gist)}`,
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
	return `/**
 * Minted by \`nosedive record.gate\` and deliberately failing. Replace this body
 * with the check itself: return false (or throw) when what it proves does not
 * hold, and return anything else when it does.
 *
 * \`ctx\` carries \`bridgeRoot\`, \`diveId\`, \`featId\`, \`gateId\`,
 * \`introducedById\`, \`repos\` keyed by kb repo name, and \`resolve(quid)\`.
 */
export async function run(ctx) {
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

function declaringFeat(
	kbDocs: KbDoc[],
	gateId: string,
): { feat: KbDoc; link: LinkRef } | undefined {
	for (const feat of kbDocs.filter((doc) => doc.kind === "feat")) {
		const link = feat.links.find(
			(candidate) =>
				candidate.id === gateId && (candidate.rel === "test.gate" || candidate.rel === "land.gate"),
		);
		if (link) return { feat, link };
	}
	return undefined;
}

function createGate(rc: NosediveRc, kbDocs: KbDoc[], options: RecordGateOptions, io: CommandIo) {
	const gist = options.gist!;
	const feat = featForGate(kbDocs, rc, options.feat!);
	const action = options.action ?? "test";

	const id = uuid7AtMs(Date.now());
	// An explicit --name wins outright. Otherwise derive a slug from the gist,
	// so the first thing a pilot sees named is what the gate checks rather than
	// a clock -- but fall back to the timestamp name if the derived slug
	// collides with a gate already declared on this feat, or the gist yields
	// nothing usable, rather than refusing to mint a runnable gate at all.
	const existingGateNames = new Set(
		feat.links
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
	writeFileAtomic(docPath, renderGateDoc(id, name, gist, scriptRel));
	appendLinkToDoc(feat.path, id, `${action}.gate`, gateLinkAttrs(undefined, options));

	io.log(`Recorded ${formatPath(docPath)}`);
	io.log(`Wrote ${formatPath(scriptPath)}`);
	io.log(`Declared ${action}.gate on ${formatPath(feat.path)}`);
	commitBridgeDocs(
		rc.bridgeDir,
		`gate(${name}): created`,
		[docPath, scriptPath, feat.path],
		io,
		feat.id,
	);
	if (action === "land") io.log("It blocks nosedive land until it passes.");
	io.log(`It fails until written. Run it with: nosedive test ${id}`);
}

function editGate(rc: NosediveRc, kbDocs: KbDoc[], options: RecordGateOptions, io: CommandIo) {
	const gate = resolveBridgeDocRef(rc.bridgeDir, kbDocs, options.ref!);
	if (gate.kind !== "gate") throw new Error(`does not resolve to a kind: gate doc: ${options.ref}`);

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

	const declared = declaringFeat(kbDocs, gate.id);
	const feat = options.feat ? featForGate(kbDocs, rc, options.feat) : declared?.feat;
	const redeclaring =
		options.feat !== undefined ||
		options.action !== undefined ||
		options.height !== undefined ||
		options.flaky !== undefined;
	if (redeclaring) {
		// Height, flakiness and action all live on the link rather than the doc, so
		// there is nowhere to put them until some feat declares the gate.
		if (!feat)
			throw new Error(`gate ${gate.name} is declared on no feat; name one with --feat <feat-ref>`);
		const rel = `${options.action ?? (declared?.link.rel === "land.gate" ? "land" : "test")}.gate`;
		if (declared && declared.feat.id !== feat.id)
			reconcileDocLink(declared.feat.path, gate.id, undefined);
		reconcileDocLink(feat.path, gate.id, rel, gateLinkAttrs(declared?.link.attrs, options));
		io.log(`Declared ${rel} on ${formatPath(feat.path)}`);
	}

	io.log(`Updated ${formatPath(gate.path)}`);
	const name = options.name ?? gate.name;
	commitBridgeDocs(
		rc.bridgeDir,
		`gate(${name}): updated`,
		[gate.path, feat?.path, declared?.feat.path],
		io,
		feat?.id,
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
