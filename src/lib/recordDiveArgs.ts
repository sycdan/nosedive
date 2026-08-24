/**
 * `record.dive`'s argument grammar, kept apart from what the command does with
 * it. The one thing it cannot answer from argv alone -- whether a positional
 * names a document -- is handed in, so the parser stays a function of what was
 * typed and the bridge lookup has one home for the whole record family.
 */
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

export function parseRecordDiveArgs(
	args: string[],
	isDocRef: (arg: string) => boolean,
): RecordDiveOptions {
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
			// The positional names the dive, the same as every other `record.*`.
			// There is no gist fallback here: this command never took one that way,
			// so a positional that resolves to nothing is a mistyped ref.
			if (!isDocRef(arg)) throw new Error(`record.dive found no document at: ${arg}`);
			if (options.ref !== undefined) throw new Error(`unexpected record.dive argument: ${arg}`);
			options.ref = arg;
			continue;
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
		else if (flag === "--ref") {
			if (options.ref !== undefined) throw new Error("record.dive names the dive twice");
			options.ref = value;
		} else if (flag === "--feat") featValue = value;
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
		throw new Error(
			"--work-branch names the branch a scope pushes to, so it needs a scope:\n" +
				'  nosedive record.dive --feat <feat> --gist "<one line>" --upscope <repo> --work-branch <branch>',
		);
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
