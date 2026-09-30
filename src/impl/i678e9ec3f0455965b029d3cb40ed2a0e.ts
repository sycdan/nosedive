import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import type { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc, uuidLike } from "../lib/coreParsing.js";
import { BLOCKS, findDocByQuid, matchDocs, mintDoc, updateBlock, type Block } from "../lib/crud.js";
import { listDeck } from "../lib/decks.js";
import { readActiveDiveId } from "../lib/kbDocs.js";
import {
	bridgeHomed,
	DECK_KIND_ID,
	DIVE_KIND_ID,
	KIND_KIND_ID,
	kindSources,
	loadKinds,
	parseQualifiedRef,
	resolveKind,
	selectRepo,
	STARTER_SCHEMA,
} from "../lib/kinds.js";
import { printCommandHelp } from "../lib/packageBacklog.js";
import { recordDive } from "../lib/recordDive.js";
import { readStdinText } from "../lib/stdinText.js";

const hint = (block: Block) =>
	`--${block} reads a merge patch from stdin: echo 'key: value' | nosedive crud <quid> --${block} -`;

/** Removes `--meta -`, `--scopes -` or `--links -` from args; stdin is the only place a patch is read from. */
function takeBlock(args: string[]): Block | undefined {
	const named = BLOCKS.filter((block) => args.includes(`--${block}`));
	if (named.length > 1)
		throw new Error(`crud patches one block at a time: ${named.map((b) => `--${b}`).join(", ")}`);
	const block = named[0];
	if (!block) return undefined;
	const at = args.indexOf(`--${block}`);
	if (args[at + 1] !== "-") throw new Error(hint(block));
	args.splice(at, 2);
	return block;
}

/** Removes a bare `<flag>` from args, and says whether it was there. */
function takeSwitch(args: string[], flag: string): boolean {
	const at = args.indexOf(flag);
	if (at === -1) return false;
	args.splice(at, 1);
	return true;
}

/** Removes `<flag> <value>` from args, wherever it sits, and returns the value. */
function takeFlag(args: string[], flag: string): string | undefined {
	const at = args.indexOf(flag);
	if (at === -1) return undefined;
	const value = args[at + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
	args.splice(at, 2);
	return value;
}

function crud(args: string[], io: CommandIo): void {
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		printCommandHelp("crud", io);
		if (args.length === 0) io.setExitCode(1);
		return;
	}
	const block = takeBlock(args);
	const replace = takeSwitch(args, "--replace");
	if (replace && !block) throw new Error("--replace goes with --meta, --scopes or --links");
	const name = takeFlag(args, "--name");
	const feat = takeFlag(args, "--feat");
	const title = takeFlag(args, "--title");
	const deck = takeFlag(args, "--deck");
	if (args.includes("--repo"))
		throw new Error(
			"crud takes no --repo; name the repo on the ref: crud <repo>:<kind> or <repo>:<quid>",
		);
	if (args.length === 0) throw new Error("crud needs a kind and a gist, or a quid");
	const [first, ...rest] = args as [string, ...string[]];
	// `<repo>:<kind>` or `<repo>:<quid>` narrows what is in play to that repo.
	const qualified = parseQualifiedRef(first);
	const sources =
		qualified.repo === undefined
			? kindSources(process.cwd())
			: selectRepo(kindSources(process.cwd()), qualified.repo);

	if (uuidLike(qualified.ref)) {
		if (name !== undefined || feat !== undefined || title !== undefined || deck !== undefined)
			throw new Error("crud <quid> takes no --name, --feat, --title or --deck");
		if (rest.length > 0) throw new Error(`crud <quid> takes nothing else: ${rest.join(" ")}`);
		const target = findDocByQuid(sources, qualified.ref);
		if (!target) throw new Error(`no doc ${first} in context`);
		if (!block) {
			io.writeOut(readFileSync(target.path, "utf8"));
			return;
		}
		const patch = parseYaml(readStdinText(hint(block))) as unknown;
		if (!patch || typeof patch !== "object" || Array.isArray(patch))
			throw new Error(`--${block} reads a YAML or JSON mapping from stdin`);
		updateBlock(target, loadKinds(sources), block, patch as Record<string, unknown>, replace, io);
		return;
	}
	if (block && (block !== "meta" || replace))
		throw new Error(`--${block} updates a doc named by its quid: crud <quid> --${block} -`);

	const gist = rest.join(" ").trim();
	if (!gist) throw new Error(`crud ${first} requires a gist`);
	const kind = resolveKind(bridgeHomed(loadKinds(sources)), first);
	if (!kind) {
		const rc = readNosediveRc(process.cwd());
		throw new Error(
			readActiveDiveId(rc.workspaceDir)
				? `no kind ${first} in context: no repo the active dive scopes declares it`
				: `no kind ${first} in context: the bridge kb declares none by that name, and \`nosedive seed\` copies in nosedive's own`,
		);
	}

	// A new doc's meta, from stdin, whole; a new kind starts with a closed, empty schema.
	const meta = block
		? (parseYaml(readStdinText(hint("meta"))) as Record<string, unknown>)
		: kind.id === KIND_KIND_ID
			? { schema: STARTER_SCHEMA }
			: {};
	if (!meta || typeof meta !== "object" || Array.isArray(meta))
		throw new Error("--meta reads a YAML or JSON mapping from stdin");
	if (kind.id === DIVE_KIND_ID) {
		if (block) throw new Error("a dive's meta is nosedive's: crud dive takes no --meta");
		if (name !== undefined) throw new Error("a dive's name is managed: crud dive takes no --name");
		if (!feat)
			throw new Error(
				"crud dive needs --feat: echo <brief> | nosedive crud dive --feat <feat> <gist...>",
			);
		recordDive(
			["--feat", feat, "--gist", gist, ...(title ? ["--title", title] : []), "--brief", "-"],
			io,
			{ target: { root: kind.source.root, kbDir: kind.source.kbDir }, deck },
		);
		return;
	}
	if (feat !== undefined || title !== undefined || deck !== undefined)
		throw new Error(`--feat, --title and --deck go with crud dive, not crud ${kind.name}`);

	// A name is the doc's identity when given: two docs may share a gist (helm's
	// default deck gist does, within a minute), so only the name is checked, by the mint.
	const matches = name === undefined ? matchDocs(kind, gist) : [];
	if (matches.length === 1) {
		if (block)
			throw new Error(
				`${kind.name} ${matches[0]!.id} already has that gist; patch its meta with crud ${matches[0]!.id} --meta -`,
			);
		io.writeOut(readFileSync(matches[0]!.path, "utf8"));
		return;
	}
	if (matches.length > 1)
		throw new Error(
			`${matches.length} ${kind.name} docs match ${JSON.stringify(gist)}; name one by quid: ` +
				matches.map((match) => `${match.id} (${match.name})`).join(", "),
		);

	mintDoc(
		kind,
		gist,
		io,
		name,
		kind.id === DECK_KIND_ID ? (doc) => listDeck(kind.source.root, doc.id, io) : undefined,
		meta,
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => crud(commandArgs, io), args);
}
