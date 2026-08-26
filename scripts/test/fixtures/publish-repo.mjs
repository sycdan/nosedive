import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { gitCommit, runTool, write } from "../../test-helpers.mjs";

/** A timestamped dev version, the shape scripts/version.mjs prints. */
export const VERSION = "2026.8.25-1787693697086";

const SURFACES = ["command-surface", "faq"];

/**
 * A stand-in for one README surface generator. The real ones parse kb/ with
 * `yaml`, which a fixture repository outside the package cannot resolve; what
 * the check depends on is the contract these share -- read this tree's
 * README.md, exit non-zero under `--check` when it is stale.
 */
function generator(marker) {
	return [
		'import { readFileSync } from "node:fs";',
		'import { dirname, join, resolve } from "node:path";',
		'import { fileURLToPath } from "node:url";',
		'const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");',
		'if (!process.argv.includes("--check")) {',
		'\tconsole.error("expected --check");',
		"\tprocess.exit(2);",
		"}",
		`if (!readFileSync(join(root, "README.md"), "utf8").includes("<!-- ${marker} fresh -->")) {`,
		`\tconsole.error("${marker} surface is stale");`,
		"\tprocess.exit(1);",
		"}",
		"",
	].join("\n");
}

function readme(staleSurface) {
	const fresh = SURFACES.filter((surface) => surface !== staleSurface);
	return ["# fixture", "", ...fresh.map((surface) => `<!-- ${surface} fresh -->`), ""].join("\n");
}

function packageFiles(dir, { packageJsonVersion, lockVersion }) {
	write(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "nosedive", version: packageJsonVersion }, null, 2)}\n`,
	);
	write(
		join(dir, "package-lock.json"),
		`${JSON.stringify(
			{
				name: "nosedive",
				version: lockVersion,
				packages: { "": { name: "nosedive", version: lockVersion } },
			},
			null,
			2,
		)}\n`,
	);
}

export function commitAll(dir, message) {
	// Forced, because a pilot whose global ignore lists package-lock.json would
	// otherwise get a fixture that never commits the file the check reads.
	runTool("git", ["add", "-A", "-f"], dir);
	gitCommit(dir, message);
	return runTool("git", ["rev-parse", "HEAD"], dir).stdout.trim();
}

/** A repository holding one source commit, shaped the way the package is. */
export function sourceRepo(tmp, label) {
	const dir = join(tmp, label);
	mkdirSync(dir, { recursive: true });
	runTool("git", ["init", "-b", "main"], dir);
	write(join(dir, "README.md"), readme());
	write(join(dir, "src", "nosedive.ts"), "export const version = 1;\n");
	write(join(dir, "scripts", "update-readme-command-surface.mjs"), generator("command-surface"));
	write(join(dir, "scripts", "update-readme-faq.mjs"), generator("faq"));
	packageFiles(dir, { packageJsonVersion: "0.0.0-dev", lockVersion: "0.0.0-dev" });
	return { dir, source: commitAll(dir, "base") };
}

/** The commit a managed publish would make. Every option names one way to spoil it. */
export function finalize(
	dir,
	{
		version = VERSION,
		packageJsonVersion = version,
		lockVersion = version,
		sourceTrailer,
		versionTrailer = version,
		staleSurface,
		extraPath,
	} = {},
) {
	packageFiles(dir, { packageJsonVersion, lockVersion });
	if (staleSurface) write(join(dir, "README.md"), readme(staleSurface));
	if (extraPath) write(join(dir, extraPath), "touched by the finalization\n");
	const message = ["Stamp the published version", ""];
	if (sourceTrailer) message.push(`Nosedive-Publish-Source: ${sourceTrailer}`);
	if (versionTrailer) message.push(`Nosedive-Publish-Version: ${versionTrailer}`);
	return commitAll(dir, message.join("\n"));
}

/** Stamps both package files the way `npm version` does, leaving them uncommitted. */
export function stampVersion(dir, version) {
	packageFiles(dir, { packageJsonVersion: version, lockVersion: version });
}

/** Rewrites README.md the way a surface generator would: changed, still fresh. */
export function regenerateReadme(dir) {
	write(join(dir, "README.md"), `${readme()}<!-- regenerated -->\n`);
}
