import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import {
	backlogMemoHasWorkLink,
	injectBacklogLinks,
	renderUpdatedBacklogMemo,
} from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import {
	formatPath,
	parseMarkdownDoc,
	readNosediveRc,
	splitMarkdownFrontmatter,
	uuidLike,
} from "../lib/coreParsing.js";
import { KbDoc, loadKbDocs } from "../lib/kbDocs.js";
import { parseLinkRefs } from "../lib/kbRefs.js";
import { posixRelPath } from "../lib/packageBacklog.js";
import { resolveBridgeDocRef } from "../lib/diveScopes.js";
import { writeFileAtomic } from "../lib/renderPlan.js";

function parseInjectRefs(args: string[]): string[] {
	const refs: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--inject") {
			const value = args[i + 1];
			if (!value) throw new Error("--inject requires a value");
			refs.push(value);
			i += 1;
			continue;
		}
		if (arg.startsWith("--inject=")) {
			const value = arg.slice("--inject=".length);
			if (!value) throw new Error("--inject requires a value");
			refs.push(value);
			continue;
		}
		throw new Error(`unexpected update-backlog argument: ${arg}`);
	}
	return refs;
}

function updateBacklog(args: string[], io: CommandIo): void {
	const injectRefs = parseInjectRefs(args);

	const rc = readNosediveRc(process.cwd());
	const memoId = rc.backlog;
	if (!memoId) throw new Error("update-backlog requires a configured backlog memo id");
	if (!uuidLike(memoId))
		throw new Error(`update-backlog requires a UUID-shaped backlog memo id: ${memoId}`);
	if (!rc.kbDir) throw new Error("update-backlog requires a configured kb directory");

	const memoPath = join(rc.kbDir, `${memoId}.md`);
	if (!existsSync(memoPath)) throw new Error(`bridge backlog memo not found: ${memoId}`);
	if (!statSync(memoPath).isFile()) throw new Error(`bridge backlog memo is not a file: ${memoId}`);

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const memoText = readFileSync(memoPath, "utf8");
	// Resolve every ref before writing anything, so a typo in the second
	// --inject cannot leave the first one half-applied.
	const targets: KbDoc[] = injectRefs.map((ref) => resolveBridgeDocRef(rc.bridgeDir, kbDocs, ref));
	for (const target of targets) {
		if (target.id === memoId) throw new Error("--inject cannot inject the backlog memo itself");
		if (target.kind === "dive" || target.kind === "repo") {
			throw new Error(`--inject names a kind: ${target.kind} doc, which is not work: ${target.id}`);
		}
	}

	let yamlLines: string[] | undefined;
	if (targets.length > 0) {
		const existing = parseLinkRefs(
			parseMarkdownDoc(memoText, formatPath(memoPath)).fm.raw.links,
			memoPath,
		);
		const result = injectBacklogLinks(
			splitMarkdownFrontmatter(memoText, formatPath(memoPath)).yaml.split(/\r?\n/),
			rc.bridgeDir,
			targets,
			(doc) => backlogMemoHasWorkLink(existing, doc),
		);
		yamlLines = result.lines;
		for (const doc of result.injected) io.log(`Injected ${doc.relPath}`);
		for (const doc of result.skipped) io.log(`Already on the backlog: ${doc.relPath}`);
	}

	const content = renderUpdatedBacklogMemo(memoText, memoPath, kbDocs, yamlLines);
	writeFileAtomic(memoPath, content);
	io.log(`Updated backlog memo: ${posixRelPath(rc.bridgeDir, memoPath)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(updateBacklog, args);
}
