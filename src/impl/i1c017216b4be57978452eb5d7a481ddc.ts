import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { CommandIo } from "../lib/bridgeSetupIo.js";
import { commitBridgeDocs } from "../lib/commitBridgeDocs.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { resolveScopeRepo } from "../lib/diveScopes.js";
import { loadKbDocs, renderKbDocTitle } from "../lib/kbDocs.js";
import { appendLinkToDoc } from "../lib/repoFeatScopes.js";
import { quoteYamlString, writeFileAtomic } from "../lib/renderPlan.js";
import { slugFromGist } from "../lib/slugs.js";
import { uuid7AtMs } from "../lib/uuid7.js";

interface NoteOptions {
	prefix?: string;
	gist: string;
	scopes: string[];
	bodyFromStdin: boolean;
	title?: string;
}

function parseNoteArgs(args: string[]): NoteOptions {
	const positionals: string[] = [];
	const scopes: string[] = [];
	let bodyFromStdin = false;
	let title: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--scope") {
			const value = args[i + 1];
			if (!value) throw new Error("--scope requires a value");
			scopes.push(value);
			i += 1;
			continue;
		}
		if (arg.startsWith("--scope=")) {
			const value = arg.slice("--scope=".length);
			if (!value) throw new Error("--scope requires a value");
			scopes.push(value);
			continue;
		}
		if (arg === "--body") {
			const value = args[i + 1];
			if (!value) throw new Error("--body requires a value");
			if (value !== "-") throw new Error("--body only accepts -");
			bodyFromStdin = true;
			i += 1;
			continue;
		}
		if (arg.startsWith("--body=")) {
			const value = arg.slice("--body=".length);
			if (!value) throw new Error("--body requires a value");
			if (value !== "-") throw new Error("--body only accepts -");
			bodyFromStdin = true;
			continue;
		}
		if (arg === "--title") {
			const value = args[i + 1];
			if (!value) throw new Error("--title requires a value");
			title = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--title=")) {
			const value = arg.slice("--title=".length);
			if (!value) throw new Error("--title requires a value");
			title = value;
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown note option: ${arg}`);
		positionals.push(arg);
	}

	if (positionals.length === 0) throw new Error("note requires a gist");
	// A note is always a memo; a leading `<prefix>:` only labels the link.
	let prefix: string | undefined;
	if (positionals[0]!.endsWith(":")) {
		const candidate = slugifyPrefix(positionals[0]!.slice(0, -1));
		if (candidate) {
			prefix = candidate;
			positionals.shift();
		}
		// A prefix that slugs to nothing is no prefix, so it remains part of the gist.
	}
	const gist = positionals.join(" ").trim();
	if (!gist) throw new Error("gist cannot be empty");
	return { prefix, gist, scopes, bodyFromStdin, title };
}

function slugifyPrefix(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function readNoteBody(): string {
	if (process.stdin.isTTY) {
		throw new Error("note --body - reads the document body on stdin; pipe it in");
	}
	return readFileSync(0, "utf8").replaceAll("\r\n", "\n").trim();
}

/**
 * The slug the name is built from, kept apart from the name itself because the
 * title renders from this half: the six hex characters exist to stop two notes
 * with the same gist colliding, and have no business in a heading.
 */
function noteSlug(gist: string): string {
	const base = slugFromGist(gist)?.split("-").slice(0, 6).join("-");
	if (!base) throw new Error("gist must contain words usable in a note name");
	return base;
}

function renderNoteDoc(options: {
	id: string;
	kind: string;
	name: string;
	slug: string;
	gist: string;
	scopes: string[];
	title?: string;
	body?: string;
}): string {
	const lines = [
		"---",
		`kind: ${options.kind}`,
		`id: ${options.id}`,
		`name: ${options.name}`,
		`gist: ${quoteYamlString(options.gist)}`,
		"scopes:",
		...options.scopes.map((scope) => `  - ${scope}`),
		"---",
		"",
		options.title ? `# ${options.title}` : renderKbDocTitle(options.slug),
	];
	if (options.body !== undefined) lines.push("", options.body);
	lines.push("");
	return lines.join("\n");
}

function note(options: NoteOptions, io: CommandIo, body?: string): void {
	const rc = readNosediveRc(process.cwd());
	if (!rc.kbDir) throw new Error("note requires a configured kb directory");
	if (!existsSync(rc.kbDir)) mkdirSync(rc.kbDir, { recursive: true });

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	// A note nobody can reach from the thing it is about is a note nobody finds,
	// so an unscoped note falls back to the bridge's own repo doc rather than
	// being written loose.
	const scopeRefs = options.scopes.length > 0 ? options.scopes : rc.bridge ? [rc.bridge] : [];
	if (scopeRefs.length === 0) {
		throw new Error("note needs a scope: this bridge's config names no bridge: repo; run seed");
	}
	const scopeDocs = scopeRefs.map((ref) => resolveScopeRepo(rc.bridgeDir, kbDocs, ref));
	if (options.scopes.length === 0) {
		const repo = scopeDocs[0]!;
		io.log(`Scoped note to bridge repo: ${repo.name} (${repo.id})`);
	}

	const id = uuid7AtMs(Date.now());
	const slug = noteSlug(options.gist);
	const name = `${slug}-${id.replaceAll("-", "").slice(-6)}`;
	const path = join(rc.kbDir, `${id}.md`);
	if (existsSync(path)) throw new Error(`kb doc already exists: ${formatPath(path)}`);
	writeFileAtomic(
		path,
		renderNoteDoc({
			id,
			kind: "memo",
			name,
			slug,
			gist: options.gist,
			scopes: scopeDocs.map((doc) => doc.id),
			title: options.title,
			body,
		}),
	);
	for (const repo of scopeDocs) appendLinkToDoc(repo.path, id, `${options.prefix ?? "memo"}.note`);

	io.log(`Noted ${formatPath(path)}`);
	commitBridgeDocs(
		rc.bridgeDir,
		`note(${name}): created`,
		[path, ...scopeDocs.map((doc) => doc.path)],
		io,
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	// Stdin is read here rather than inside `note`, because the body has to be
	// in hand before the command's own output starts being captured.
	const options = parseNoteArgs(args);
	const body = options.bodyFromStdin ? readNoteBody() : undefined;
	return captureCommand((_commandArgs, io) => note(options, io, body), args);
}
