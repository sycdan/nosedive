import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { parse as parseYaml } from "yaml";

import { captureCommand } from "./commandAdapter.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";
import type { CommandIo } from "../lib/bridgeSetupIo.js";
import { readNosediveRc, uuidLike } from "../lib/coreParsing.js";
import {
	BLOCKS,
	findDocByQuid,
	matchDocs,
	mintDoc,
	mintName,
	updateTitle,
	updateBlock,
	type Block,
} from "../lib/crud.js";
import { builtinKindPath } from "../lib/builtinKinds.js";
import { diveRepinPatch, diveScopesPatch } from "../lib/diveScopePatch.js";
import { readActiveDiveId, readKbDoc } from "../lib/kbDocs.js";
import {
	bridgeHomed,
	DIVE_KIND_ID,
	isBridge,
	KIND_KIND_ID,
	kindSources,
	type KindSource,
	loadKinds,
	parseQualifiedRef,
	REPO_KIND_ID,
	repoKind,
	resolveKind,
	selectRepo,
	STARTER_SCHEMA,
} from "../lib/kinds.js";
import { printCommandHelp } from "../lib/packageBacklog.js";
import { recordDive } from "../lib/recordDive.js";
import { readQualifiedRef } from "../lib/repoRead.js";
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

/** Removes `--repin [<ref>]` from args; the ref is the next word unless it is a flag, as record.dive reads it. */
function takeRepin(args: string[]): { ref?: string } | undefined {
	const at = args.findIndex((arg) => arg === "--repin" || arg.startsWith("--repin="));
	if (at === -1) return undefined;
	const arg = args[at]!;
	if (arg !== "--repin") {
		args.splice(at, 1);
		return { ref: arg.slice("--repin=".length) };
	}
	const next = args[at + 1];
	const ref = next !== undefined && !next.startsWith("--") ? next : undefined;
	args.splice(at, ref === undefined ? 1 : 2);
	return { ref };
}

/**
 * `crud <dive> --repin [<ref>] [--scope <repo>]`: record.dive's repin, on a
 * dive named by its quid, written where crud finds the dive.
 */
function repinDive(
	args: string[],
	repin: { ref?: string },
	scope: string | undefined,
	io: CommandIo,
) {
	const usage = "crud <dive-quid> --repin [<ref>] [--scope <repo>]";
	if (args.length !== 1 || !uuidLike(args[0]!)) throw new Error(`--repin repins a dive: ${usage}`);
	// Paired as record.dive pairs them: a ref names one repo.
	if (repin.ref === "") throw new Error("--repin requires a value when one is given");
	if (repin.ref !== undefined && scope === undefined)
		throw new Error("--repin <ref> requires --scope <repo-ref>: a ref names one repo");
	if (scope !== undefined && repin.ref === undefined)
		throw new Error("--scope requires --repin <ref>: it names the scope that ref moves");
	const inPlay = liveDive(args[0]!) || kindSources(process.cwd());
	const target = findDocByQuid(inPlay, args[0]!);
	if (!target) throw new Error(`no doc ${args[0]} in context`);
	const scopes = diveRepinPatch(target, { ref: repin.ref, scope }, io);
	updateBlock(target, loadKinds(inPlay), "scopes", scopes, true, io, inPlay);
}

/**
 * The active dive is jump's and land's record, so crud reads and patches the
 * live bridge's copy, never a `__self` one -- and needs no scoped repo
 * hydrated. Any other dive resolves like any other doc.
 */
function liveDive(ref: string): KindSource[] | undefined {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir || !uuidLike(ref) || readActiveDiveId(rc.workspaceDir) !== ref.toLowerCase())
		return undefined;
	return [{ id: rc.bridge, name: basename(rc.bridgeDir), root: rc.bridgeDir, kbDir: rc.kbDir }];
}

/**
 * Every write but a scope edit goes through a dive, so land reviews it before
 * anyone reads it. Scopes are bookkeeping the bridge alone is read for, as is
 * a dive's pin, so `--scopes` and `--repin` stay direct.
 */
function refuseWithoutDive(what: string): void {
	if (readActiveDiveId(readNosediveRc(process.cwd()).workspaceDir)) return;
	throw new Error(
		`crud writes on a dive: no dive is active to ${what}; jump one first, as \`nosedive jump <feat>\` starts one`,
	);
}

function crud(args: string[], io: CommandIo): void {
	if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
		printCommandHelp("crud", io);
		if (args.length === 0) io.setExitCode(1);
		return;
	}
	const repin = takeRepin(args);
	if (repin) {
		// Only with --repin: --scope names the one scope a ref moves.
		const scope = takeFlag(args, "--scope");
		const unknown = args.find((arg) => arg.startsWith("--"));
		if (unknown !== undefined) throw new Error(`crud --repin takes no ${unknown}`);
		repinDive(args, repin, scope, io);
		return;
	}
	const block = takeBlock(args);
	const replace = takeSwitch(args, "--replace");
	if (replace && !block) throw new Error("--replace goes with --meta, --scopes or --links");
	const name = takeFlag(args, "--name");
	const feat = takeFlag(args, "--feat");
	const title = takeFlag(args, "--title");
	if (title !== undefined && (!title.trim() || /[\r\n]/.test(title)))
		throw new Error("--title requires a nonempty single line");
	if (args.includes("--repo"))
		throw new Error(
			"crud takes no --repo; name the repo on the ref: crud <repo>:<kind> or <repo>:<quid>",
		);
	const unknown = args.find((arg) => arg.startsWith("--"));
	if (unknown !== undefined) throw new Error(`crud takes no ${unknown}`);
	if (args.length === 0) throw new Error("crud needs a kind and a gist, or a quid");
	const [first, ...rest] = args as [string, ...string[]];
	// `<repo>:<kind>` or `<repo>:<quid>` narrows what is in play to that repo;
	// the kinds stay every repo's in play, since a repo can take a shipped one.
	const qualified = parseQualifiedRef(first);
	const bare = !block && rest.length === 0 && [name, feat, title].every((v) => v === undefined);
	if (qualified.repo !== undefined && bare) {
		const rc = readNosediveRc(process.cwd());
		const text = readQualifiedRef(rc, qualified.repo, qualified.ref);
		if (text !== undefined) {
			io.writeOut(text);
			return;
		}
	}
	const inPlay =
		(qualified.repo === undefined && liveDive(qualified.ref)) || kindSources(process.cwd());
	const sources = qualified.repo === undefined ? inPlay : selectRepo(inPlay, qualified.repo);
	const kinds = loadKinds(inPlay);

	if (uuidLike(qualified.ref)) {
		if (name !== undefined || feat !== undefined)
			throw new Error("crud <quid> takes no --name or --feat");
		if (rest.length > 0) throw new Error(`crud <quid> takes nothing else: ${rest.join(" ")}`);
		const target = findDocByQuid(sources, qualified.ref);
		if (!target) throw new Error(`no doc ${first} in context`);
		if ((block || title !== undefined) && builtinKindPath(qualified.ref.toLowerCase()))
			throw new Error(`built-in kind ${qualified.ref} is read-only in the package`);
		if (!block && title === undefined) {
			io.writeOut(readFileSync(target.path, "utf8"));
			return;
		}
		if (block !== "scopes") refuseWithoutDive(`edit ${first}`);
		if (!block) {
			updateTitle(target, title!, io);
			return;
		}
		const patch = parseYaml(readStdinText(hint(block))) as unknown;
		if (!patch || typeof patch !== "object" || Array.isArray(patch))
			throw new Error(`--${block} reads a YAML or JSON mapping from stdin`);
		// A dive's scopes take record.dive's rules, then are written whole.
		if (block === "scopes" && readKbDoc(target.path, target.source.root).kind === "dive") {
			const scopes = diveScopesPatch(target, patch as Record<string, unknown>, replace);
			updateBlock(target, kinds, block, scopes, true, io, inPlay, title);
			return;
		}
		updateBlock(target, kinds, block, patch as Record<string, unknown>, replace, io, inPlay, title);
		return;
	}
	if (block && (block !== "meta" || replace))
		throw new Error(`--${block} updates a doc named by its quid: crud <quid> --${block} -`);

	const gist = rest.join(" ").trim();
	if (!gist) throw new Error(`crud ${first} requires a gist`);
	const repo = sources[0]!;
	const kind =
		qualified.repo === undefined
			? resolveKind(bridgeHomed(kinds), first)
			: repoKind(kinds, repo, qualified.ref);
	if (!kind && qualified.repo !== undefined && !isBridge(repo)) {
		// Only the kind kind crosses into another repo; say why one that did not is out.
		if (kinds.some((k) => k.id === DIVE_KIND_ID && k.name === qualified.ref))
			throw new Error(
				`a dive lives only in a bridge: crud ${qualified.ref} --feat <feat> <gist...>`,
			);
		if (kinds.some((k) => k.id === REPO_KIND_ID && k.name === qualified.ref))
			throw new Error(`a repo doc lives only in a bridge: crud ${qualified.ref} <gist...>`);
		if (kinds.some((k) => isBridge(k.source) && k.name === qualified.ref))
			throw new Error(
				`kind ${qualified.ref} is the bridge's own, and only the kind kind goes into ${repo.name}; ` +
					`${repo.name} can define its own: crud ${qualified.repo}:kind --name ${qualified.ref} <gist...>`,
			);
	}
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

		if (!feat)
			throw new Error("crud dive needs --feat: nosedive crud dive --feat <feat> <gist...>");
		refuseWithoutDive("plan a dive");
		const brief = process.stdin.isTTY
			? undefined
			: readStdinText("crud dive optionally reads its brief on stdin");
		recordDive(["--feat", feat, "--gist", gist, ...(title ? ["--title", title] : [])], io, {
			brief,
			name: name === undefined ? undefined : mintName(kind, name),
			target: { root: kind.source.root, kbDir: kind.source.kbDir },
		});
		return;
	}
	if (feat !== undefined || title !== undefined)
		throw new Error(`--feat and --title go with crud dive, not crud ${kind.name}`);

	// A name is the doc's identity when given: two docs may share a gist, so
	// only the name is checked, by the mint.
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

	refuseWithoutDive(`make a ${kind.name}`);
	mintDoc(kind, gist, io, name, meta);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand((commandArgs, io) => crud(commandArgs, io), args);
}
