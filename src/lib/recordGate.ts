import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { CommandIo } from "./bridgeSetupIo.js";
import { formatPath, NosediveRc, readNosediveRc } from "./coreParsing.js";
import { KbDoc, loadKbDocs } from "./kbDocs.js";
import { quoteYamlString, writeFileAtomic } from "./renderPlan.js";
import { appendLinkToDoc, resolveFeatDoc } from "./repoFeatScopes.js";
import { assertSlug, slugFromGist, titleFromSlug } from "./slugs.js";
import { uuid7AtMs } from "./uuid7.js";

export interface RecordGateOptions {
	gist: string;
	feat: string;
	name?: string;
	/** `gate-height` on the minted link; taller gates run first. */
	height?: number;
	/** `test-is-flaky` on the minted link; a flaky gate reports but never blocks. */
	flaky: boolean;
}

function optionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseRecordGateArgs(args: string[]): RecordGateOptions {
	let gist: string | undefined;
	let feat: string | undefined;
	let name: string | undefined;
	let height: number | undefined;
	let flaky = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--flaky") {
			flaky = true;
			continue;
		}
		const flag = ["--feat", "--name", "--height"].find(
			(candidate) => arg === candidate || arg.startsWith(`${candidate}=`),
		);
		if (!flag) {
			if (arg.startsWith("--")) throw new Error(`unknown record.gate option: ${arg}`);
			if (gist !== undefined) throw new Error(`unexpected record.gate argument: ${arg}`);
			gist = arg;
			continue;
		}
		const value = arg === flag ? optionValue(args, i + 1, flag) : arg.slice(flag.length + 1);
		if (!value) throw new Error(`${flag} requires a value`);
		if (arg === flag) i += 1;
		if (flag === "--feat") feat = value;
		else if (flag === "--name") name = assertSlug(value, "--name");
		else {
			if (!/^-?\d+$/.test(value.trim())) throw new Error(`--height must be an integer: ${value}`);
			height = Number.parseInt(value.trim(), 10);
		}
	}

	if (gist === undefined || !gist.trim()) throw new Error("record.gate requires a gist");
	// A test.gate has to be declared where a feat is in context, or a failing
	// backlog sweep has nothing to mint work against.
	if (!feat) throw new Error("record.gate requires --feat");
	return { gist: gist.trim(), feat, name, height, flaky };
}

/**
 * The same shape and the same reason as `pitch`'s default feat name: a gate can
 * be minted before anybody has a good name for it, and renamed later.
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

function gateLinkAttrs(options: RecordGateOptions): Record<string, string | number | boolean> {
	const attrs: Record<string, string | number | boolean> = {};
	if (options.height !== undefined) attrs["gate-height"] = options.height;
	if (options.flaky) attrs["test-is-flaky"] = true;
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

export function recordGate(args: string[], io: CommandIo): void {
	const options = parseRecordGateArgs(args);
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("record.gate requires a configured kb directory");
	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const feat = featForGate(kbDocs, rc, options.feat);

	const id = uuid7AtMs(Date.now());
	// An explicit --name wins outright. Otherwise derive a slug from the gist,
	// so the first thing a pilot sees named is what the gate checks rather than
	// a clock -- but fall back to the timestamp name if the derived slug
	// collides with a gate already declared on this feat, or the gist yields
	// nothing usable, rather than refusing to mint a runnable gate at all.
	const existingGateNames = new Set(
		feat.links
			.filter((link) => link.rel === "test.gate")
			.map((link) => kbDocs.find((doc) => doc.id === link.id)?.name)
			.filter((docName): docName is string => docName !== undefined),
	);
	const derived = slugFromGist(options.gist);
	const name =
		options.name ?? (derived && !existingGateNames.has(derived) ? derived : defaultGateName());
	const docPath = join(rc.kbDir, `${id}.md`);
	const scriptRel = `kb/artifacts/${id}.mjs`;
	const scriptPath = join(rc.kbDir, "artifacts", `${id}.mjs`);
	if (existsSync(docPath)) throw new Error(`kb doc already exists: ${formatPath(docPath)}`);

	// The doc and the script are one thing: `resolveGateScript` hard-fails a gate
	// whose script does not resolve, so a command that minted only the doc would
	// produce something that breaks the moment anything selects it.
	mkdirSync(join(rc.kbDir, "artifacts"), { recursive: true });
	writeFileAtomic(scriptPath, renderGateStub(scriptRel));
	writeFileAtomic(docPath, renderGateDoc(id, name, options.gist, scriptRel));
	appendLinkToDoc(feat.path, id, "test.gate", gateLinkAttrs(options));

	io.log(`Recorded ${formatPath(docPath)}`);
	io.log(`Wrote ${formatPath(scriptPath)}`);
	io.log(`Declared test.gate on ${formatPath(feat.path)}`);
	io.log(`It fails until written. Run it with: nosedive test ${id}`);
}
