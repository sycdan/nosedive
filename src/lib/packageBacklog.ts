import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CommandIo, Migration } from "./bridgeSetupIo.js";
import { gitOutput, runGit } from "./gitProcess.js";
import { BRIDGE_STATE_DIRNAME, MIGRATION_BACKUP_DIRNAME, shellQuote } from "./constants.js";
import {
	configCompatibilityLevel,
	findBridgeConfig,
	formatPath,
	parseFrontmatter,
	parseMarkdownDoc,
	parseMarkdownFrontmatter,
	parseYamlBlock,
	readNosediveRc,
	resolveFrom,
	toPosixPath,
	truncate,
	uuidLike,
} from "./coreParsing.js";
import { KbDoc } from "./kbDocs.js";
import { unsafeLinkPath } from "./proveCore.js";
import { writeFileAtomic } from "./renderPlan.js";
import { pascalFromSlug, titleFromSlug } from "./slugs.js";

const LOCAL_DEV_VERSION = "0.0.0-dev";

export function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Renders the reproducible invocation for one package version and root. */
export function nosediveInvocationFor(version: string, root: string): string {
	if (version !== LOCAL_DEV_VERSION) return `npx -y nosedive@${version}`;
	return `node ${shellQuote(toPosixPath(join(root, "dist", "cli.js")))}`;
}

/** A reproducible invocation of the package version currently running. */
export function nosediveInvocation(): string {
	return nosediveInvocationFor(nosedivePackageVersion(), packageRoot());
}

/** The version of the package executing this command. */
export function nosedivePackageVersion(): string {
	const root = packageRoot();
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		version: string;
	};
	return version;
}

/**
 * A fingerprint of the command surface `seed` renders into an agent instruction
 * block, so `preflight` can tell whether an instruction file describes commands
 * the installed nosedive actually has.
 *
 * The version is deliberately not part of the input. A shared `AGENTS.md` is
 * checked in, and a pilot whose install is older but whose surface is identical
 * has no problem to report -- warning them anyway is how a warning stops being
 * read. The version is compared separately, and only once the digests already
 * disagree, to say which side is stale.
 */
export function renderedSurfaceDigest(): string {
	return createHash("sha256")
		.update(renderTopLevelHelp({ agents: true }).trim())
		.digest("hex")
		.slice(0, 8);
}

function parseCalVer(version: string): [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareCalVer(left: string, right: string): number | undefined {
	const leftParts = parseCalVer(left);
	const rightParts = parseCalVer(right);
	if (!leftParts || !rightParts) return undefined;
	for (let index = 0; index < leftParts.length; index += 1) {
		const delta = leftParts[index] - rightParts[index];
		if (delta !== 0) return delta;
	}
	return 0;
}

/**
 * The commit the running build came from, when it came from a checkout at all.
 *
 * The toplevel check is not paranoia: a published install lives under some
 * project's `node_modules`, and asking git about it there answers about the
 * project, not about nosedive. Only a root that is its own repository is one.
 */
export function packageCommit(): string | undefined {
	const root = packageRoot();
	const toplevel = gitOutput(root, ["rev-parse", "--show-toplevel"]);
	if (!toplevel || resolve(toplevel) !== resolve(root)) return undefined;
	return gitOutput(root, ["rev-parse", "HEAD"]);
}

/** Whether `commit` is reachable from the running build's checkout. */
export function packageCommitContains(commit: string): boolean | undefined {
	const root = packageRoot();
	if (packageCommit() === undefined) return undefined;
	const result = runGit(root, ["merge-base", "--is-ancestor", commit, "HEAD"]);
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	return undefined;
}

/** The stamp `seed` writes and `preflight` reads back. */
export function renderSurfaceStamp(version: string, digest: string, commit?: string): string {
	const commitPart = commit ? ` commit=${commit}` : "";
	return `<!-- nosedive v=${version}${commitPart} surface=${digest} -->`;
}

export const SURFACE_STAMP_PATTERN =
	/^<!-- nosedive v=(\S+?)(?: commit=([0-9a-f]{7,40}))? surface=([0-9a-f]{8}) -->$/;

/**
 * Which side of a digest mismatch is stale, when that can be established.
 *
 * `unknown` is a real answer and the common one on a source checkout, where
 * both sides read `0.0.0-dev` and the version carries no ordering at all.
 */
type StampOrder = "installed-newer" | "installed-older" | "same" | "unknown";

function stampOrder(
	stamped: { version: string; commit?: string },
	installedVersion: string,
	containsCommit: (commit: string) => boolean | undefined,
): StampOrder {
	const comparison = compareCalVer(stamped.version, installedVersion);
	if (comparison !== undefined) {
		if (comparison > 0) return "installed-older";
		if (comparison < 0) return "installed-newer";
		return "same";
	}
	// No CalVer on either side, so the only ordering left is the checkout's own
	// history. Reachable means this build already contains whatever wrote the
	// block; unreachable means a sibling branch, which proves nothing.
	if (stamped.commit && containsCommit(stamped.commit) === true) return "installed-newer";
	return "unknown";
}

/**
 * What to say about an instruction block whose surface digest does not match the
 * build reading it.
 *
 * The rule every branch here exists to keep: never order a reseed unless the
 * installed side is provably at least as new. Seeding overwrites a file every
 * pilot on the bridge reads, so ordering it from an older install silently
 * removes commands the block listed correctly, and the next pilot is told to
 * upgrade against a block that just got worse.
 *
 * A mismatch between two source checkouts is reported without the `nose:`
 * prefix. It is real -- the pilot's own agents are reading a stale block -- but
 * it is theirs alone, it is present through any session that touches the command
 * surface, and a call to attention that never clears stops being read.
 */
export function describeInstructionDrift(options: {
	file: string;
	stamped?: { version: string; commit?: string; digest: string };
	installedVersion: string;
	installedDigest: string;
	containsCommit?: (commit: string) => boolean | undefined;
}): string | undefined {
	if (options.stamped === undefined) {
		return (
			`nose: ${options.file}'s managed instructions carry no version stamp, so nosedive cannot ` +
			`tell what surface they describe. Reseed with nosedive seed if this install is current.`
		);
	}
	if (options.stamped.digest === options.installedDigest) return undefined;

	const order = stampOrder(
		options.stamped,
		options.installedVersion,
		options.containsCommit ?? (() => undefined),
	);
	// Both sides, not either: a published install reading a block some checkout
	// stamped is not the pilot's own local drift, and it will not clear on its own.
	const devLocal =
		parseCalVer(options.stamped.version) === undefined &&
		parseCalVer(options.installedVersion) === undefined;

	if (order === "installed-older") {
		return (
			`nose: ${options.file}'s agent instructions come from nosedive ${options.stamped.version}; ` +
			`you have ${options.installedVersion}. Run: npm i -g nosedive@${options.stamped.version}`
		);
	}
	if (order === "installed-newer" && !devLocal) {
		return `nose: your nosedive renders commands ${options.file}'s agent instructions do not list. Run: nosedive seed`;
	}
	if (order === "installed-newer") {
		return `${options.file}'s managed instructions describe an earlier commit of this checkout. Run: nosedive seed`;
	}
	// Equal CalVer with differing digests: the same version renders the same
	// surface, so the block did not come from this build at all, and reseeding
	// cannot lose anything this build would have listed.
	if (order === "same") {
		return `nose: ${options.file}'s managed instructions do not match nosedive ${options.installedVersion}. Run: nosedive seed`;
	}
	if (devLocal) {
		return (
			`${options.file}'s managed instructions do not match this build, and nosedive cannot tell ` +
			`which is newer. Reseed only if this checkout is ahead of the one that wrote them.`
		);
	}
	return (
		`nose: ${options.file}'s managed instructions do not match nosedive ${options.installedVersion}, ` +
		`and nosedive cannot tell which is newer. Reseed only if this install is current.`
	);
}

export function packageDocsOfKind(kind: string): Array<{ filename: string; content: string }> {
	const kbDir = join(packageRoot(), "kb");
	if (!existsSync(kbDir)) return [];

	return readdirSync(kbDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => {
			const sourcePath = join(kbDir, entry.name);
			const content = readFileSync(sourcePath, "utf8");
			const fm = parseMarkdownFrontmatter(content, formatPath(sourcePath));
			return fm.scalars.kind === kind ? { filename: entry.name, content } : undefined;
		})
		.filter((doc): doc is { filename: string; content: string } => doc !== undefined);
}
export function packageMigrationDocs(): Array<{ filename: string; content: string }> {
	return packageDocsOfKind("migration");
}

export function bridgeCompatibilityLevel(start: string): number | undefined {
	const resolved = findBridgeConfig(start);
	if (!resolved) return undefined;
	if (resolved.shape === "legacy") return 0;
	const base = parseYamlBlock(
		readFileSync(resolved.basePath, "utf8"),
		formatPath(resolved.basePath),
	);
	return configCompatibilityLevel(base, resolved.basePath);
}

/** The level of the bridge under `start`, or undefined if none is readable. */
export function maybeBridgeCompatibilityLevel(start: string): number | undefined {
	try {
		return bridgeCompatibilityLevel(start);
	} catch {
		return undefined;
	}
}

/**
 * An explicit `<command>@<N>` may outrun the bridge it is pointed at, because
 * that is how a level gets exercised before any bridge has migrated to it. Say
 * so out loud so nobody mistakes the escape hatch for a supported route.
 */
export function aheadOfBridgeWarning(
	command: string,
	level: number,
	bridgeLevel: number | undefined,
): string | undefined {
	if (bridgeLevel === undefined || level <= bridgeLevel) return undefined;
	return (
		`nosedive: warning: ${command}@${level} is ahead of this bridge (level ${bridgeLevel}); ` +
		`running a command ahead of the bridge is not an officially-supported pathway\n`
	);
}

export let commandHelpPrinter: ((command: string, io: CommandIo) => void) | undefined;

export function setCommandHelpPrinter(print: (command: string, io: CommandIo) => void): void {
	commandHelpPrinter = print;
}

export function printCommandHelp(command: string, io: CommandIo): void {
	if (!commandHelpPrinter)
		throw new Error(`no command help printer configured for command: ${command}`);
	commandHelpPrinter(command, io);
}

export let topLevelHelpRenderer: ((options?: { agents?: boolean }) => string) | undefined;

export function setTopLevelHelpRenderer(render: (options?: { agents?: boolean }) => string): void {
	topLevelHelpRenderer = render;
}

/**
 * The `nosedive help` text, for commands that embed the command surface in what
 * they write. `agents` renders the agent-facing variant, which states each
 * command's `meta.agents-use-when` trigger.
 */
export function renderTopLevelHelp(options?: { agents?: boolean }): string {
	if (!topLevelHelpRenderer) throw new Error("no top-level help renderer configured");
	return topLevelHelpRenderer(options);
}
export const NOSEDIVE_DIR_GITIGNORE = ["cache/", `${MIGRATION_BACKUP_DIRNAME}/`, ""].join("\n");

/** nosedive owns ignore rules for its own state under `.nosedive/`: the git cache and migration backups are local, `config.yaml` is not. */
export function writeNosediveDirGitignore(bridgeDir: string): void {
	writeFileAtomic(join(bridgeDir, BRIDGE_STATE_DIRNAME, ".gitignore"), NOSEDIVE_DIR_GITIGNORE);
}

export function firstMarkdownHeading(body: string, fallback: string): string {
	const match = /^#\s+(.+?)\s*$/m.exec(body);
	return match?.[1]?.trim() || fallback;
}

export function posixRelPath(from: string, to: string): string {
	return relative(from, to).replaceAll("\\", "/");
}

export function featDocTitle(doc: KbDoc, leafSlug: string): string {
	const body = parseMarkdownDoc(readFileSync(doc.path, "utf8"), formatPath(doc.path)).body;
	return firstMarkdownHeading(body, titleFromSlug(leafSlug));
}

/** The title a backlog entry renders under: its H1, or its name's leaf slug. */
export function backlogDocTitle(doc: KbDoc): string {
	return featDocTitle(doc, doc.name.split(".").filter(Boolean)[0] ?? doc.id);
}

export function backlogEntryLine(doc: KbDoc, depth: number): string {
	const gist = doc.gist ? `: ${doc.gist}` : "";
	return `${"  ".repeat(depth)}- [${backlogDocTitle(doc)}](${basename(doc.path)})${gist}`;
}
