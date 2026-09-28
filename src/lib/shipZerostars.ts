import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { formatPath, toPosixPath } from "./coreParsing.js";
import { runGit } from "./gitProcess.js";
import { readKbDoc } from "./kbDocs.js";
import { isZerostar } from "./kinds.js";
import { packageRoot } from "./packageBacklog.js";
import { writeFileAtomic } from "./renderPlan.js";
import { appendLinkToDoc } from "./repoFeatScopes.js";

/** The standing feat every bridge dives from when no other feat fits. */
export const KB_FEAT_ID = "00000000-0000-7003-a10b-25d64dd1d5ba";

/** Shipped zerostars written once and then the bridge's own: seed never merges them again. */
const CREATE_ONLY = new Set([KB_FEAT_ID]);

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * The docs in a kb that ship: every zerostar whose own frontmatter names no
 * scopes. One scoped to a repo -- nosedive's glossary, scoped to nosedive --
 * is internal to that repo.
 */
export function shippedFiles(kbDir: string): string[] {
	if (!existsSync(kbDir)) return [];
	return readdirSync(kbDir)
		.filter((file) => file.endsWith(".md") && isZerostar(basename(file, ".md")))
		.filter((file) => {
			const frontmatter = FRONTMATTER.exec(readFileSync(join(kbDir, file), "utf8"))?.[1] ?? "";
			return !/^scopes:/m.test(frontmatter);
		})
		.sort();
}

/** The create-only doc as this bridge's: scoped to the bridge itself, writable on its work branch. */
function withBridgeScope(text: string, bridgeRepoId: string, workBranch: string): string {
	const match = FRONTMATTER.exec(text)!;
	const lines = match[1]!.split(/\r?\n/);
	const at = lines.findIndex((line) => /^(meta|links):/.test(line));
	const scope = ["scopes:", `  - ${bridgeRepoId}:`, `      work-branch: ${workBranch}`];
	lines.splice(at === -1 ? lines.length : at, 0, ...scope);
	return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}

/** What seed last wrote at `rel`, or "" when no seed commit ever touched it. */
function lastSeeded(bridgeDir: string, rel: string): string {
	const sha = runGit(bridgeDir, [
		"log",
		"-1",
		"--format=%H",
		"--grep=^seed(",
		"--",
		rel,
	]).stdout.trim();
	if (!sha) return "";
	const shown = runGit(bridgeDir, ["show", `${sha}:${rel}`]);
	return shown.status === 0 ? shown.stdout : "";
}

/**
 * `git merge-file`: the bridge's copy, what seed last wrote, and the
 * package's copy. Returns the merge -- with conflict markers when both sides
 * changed the same lines -- and whether it conflicted.
 */
function mergeThreeWay(
	ours: string,
	base: string,
	theirs: string,
): { text: string; conflicted: boolean } {
	const dir = mkdtempSync(join(tmpdir(), "nosedive-seed-merge-"));
	try {
		const [oursPath, basePath, theirsPath] = ["bridge", "seeded", "nosedive"].map((name) =>
			join(dir, name),
		);
		writeFileSync(oursPath!, ours);
		writeFileSync(basePath!, base);
		writeFileSync(theirsPath!, theirs);
		const merged = runGit(dir, [
			"merge-file",
			"-p",
			"-L",
			"bridge",
			"-L",
			"last seeded",
			"-L",
			"nosedive",
			oursPath!,
			basePath!,
			theirsPath!,
		]);
		// merge-file exits with its conflict count, capped at 127; anything else is an error.
		if (merged.status === null || merged.status > 127)
			throw new Error(`git merge-file failed: ${merged.stderr.trim()}`);
		return { text: merged.stdout, conflicted: merged.status > 0 };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Brings every shipped zerostar into a bridge kb and returns the paths seed
 * should commit. A missing doc is written. An owned doc that differs is merged
 * three ways -- the bridge's copy, what seed last wrote there, the package's --
 * so the pilot's edits survive a package update; a conflict leaves its markers
 * in the file and fails seed before anything is committed. A create-only doc
 * is written once, scoped to the bridge, and linked from the backlog as
 * `zerostar.feat`; after that it is the bridge's.
 */
export function shipZerostars(
	bridgeDir: string,
	kbDir: string,
	bridgeRepoId: string,
	workBranch: string,
	backlogPath: string | undefined,
	io: { log(message: string): void },
): string[] {
	const packageKb = join(packageRoot(), "kb");
	const files = shippedFiles(packageKb);
	const rels = files.map((file) => toPosixPath(relative(bridgeDir, join(kbDir, file))));

	const dirty = runGit(bridgeDir, ["status", "--porcelain", "--", ...rels]).stdout.trim();
	if (dirty)
		throw new Error(
			`seed merges nosedive's shipped docs into these, which have uncommitted changes; commit or discard them first:\n${dirty}`,
		);

	const paths: string[] = [];
	const conflicts: string[] = [];
	files.forEach((file, i) => {
		const path = join(kbDir, file);
		const shipped = readFileSync(join(packageKb, file), "utf8");
		paths.push(path);
		if (CREATE_ONLY.has(basename(file, ".md"))) {
			if (existsSync(path)) return;
			writeFileAtomic(path, withBridgeScope(shipped, bridgeRepoId, workBranch));
			io.log(`Wrote ${formatPath(path)}`);
			return;
		}
		if (!existsSync(path)) {
			writeFileAtomic(path, shipped);
			io.log(`Wrote ${formatPath(path)}`);
			return;
		}
		const current = readFileSync(path, "utf8");
		if (current === shipped) return;
		const merged = mergeThreeWay(current, lastSeeded(bridgeDir, rels[i]!), shipped);
		if (merged.text === current) return;
		writeFileAtomic(path, merged.text);
		if (merged.conflicted) conflicts.push(formatPath(path));
		else io.log(`Merged ${formatPath(path)}`);
	});
	if (conflicts.length > 0)
		throw new Error(
			`nosedive's shipped docs conflict with edits in this bridge; resolve the markers, commit, and seed again:\n  ${conflicts.join("\n  ")}`,
		);

	if (backlogPath && existsSync(backlogPath) && files.includes(`${KB_FEAT_ID}.md`)) {
		const backlog = readKbDoc(backlogPath, bridgeDir);
		if (!backlog.links.some((link) => link.id === KB_FEAT_ID)) {
			appendLinkToDoc(backlogPath, KB_FEAT_ID, "zerostar.feat");
			io.log(`Linked the kb feat from ${formatPath(backlogPath)}`);
			paths.push(backlogPath);
		}
	}
	return paths;
}
