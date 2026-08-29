import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { renderCommandHelpText } from "../src/lib/commandHelpText.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetPath = join(root, "COMMANDS.md");
const packageJsonPath = join(root, "package.json");
const kbDir = join(root, "kb");
const libDir = join(root, "src", "lib");
const beginMarker = "<!-- BEGIN nosedive-command-surface -->";
const endMarker = "<!-- END nosedive-command-surface -->";
const levelsBeginMarker = "<!-- BEGIN nosedive-levels -->";
const levelsEndMarker = "<!-- END nosedive-levels -->";

function rel(path) {
	return relative(root, path).replaceAll("\\", "/");
}

function fail(message) {
	throw new Error(message);
}

function read(path) {
	return readFileSync(path, "utf8");
}

function parseFrontmatter(text, label) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return undefined;
	try {
		return YAML.parse(match[1] ?? "") ?? {};
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		fail(`${label} has invalid YAML frontmatter: ${detail}`);
	}
}

function parseCommandName(name) {
	const match = /^(.+)@([0-9]+)$/.exec(String(name ?? ""));
	if (!match) return undefined;
	return {
		command: match[1],
		level: Number.parseInt(match[2], 10),
	};
}

function commandDocs() {
	const docs = [];
	for (const filename of readdirSync(kbDir)
		.filter((name) => name.endsWith(".md"))
		.sort()) {
		const path = join(kbDir, filename);
		const text = read(path);
		const raw = parseFrontmatter(text, filename);
		if (!raw || raw.kind !== "command") continue;
		const parsedName = parseCommandName(raw.name);
		if (!parsedName) fail(`${filename} command name must look like <command>@<level>`);
		docs.push({
			filename,
			path,
			relPath: rel(path),
			id: String(raw.id ?? ""),
			command: parsedName.command,
			level: parsedName.level,
			gist: String(raw.gist ?? ""),
			usage: String(raw.meta?.usage ?? ""),
			useInstead: String(raw.meta?.["use-instead"] ?? ""),
			body: text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""),
		});
	}
	for (const doc of docs) {
		const title = /^#\s+(.+?)\s*$/m.exec(doc.body)?.[1];
		if (!title) fail(`${doc.filename} command doc must have an H1 title`);
		doc.title = title;
	}
	return docs;
}

function markdownLink(label, target) {
	return `[${label}](${target})`;
}

function tableCell(value) {
	return String(value).replaceAll("|", "\\|").replace(/\r?\n/g, "<br>").trim();
}

function code(value) {
	return `\`${value}\``;
}

function usageForReadme(usage) {
	return usage.replace(/^nosedive\b/, "npx nosedive");
}

// `contract-help.mjs` compares this with the runtime's
// `nosediveInvocationFor(false, root)`, so README examples cannot drift from
// the invocation agents receive from the package helper.
function publishedNosediveInvocation() {
	const version = JSON.parse(read(packageJsonPath)).version;
	return `npx -y nosedive@${version}`;
}

function latestDocsByCommand(docs) {
	const latest = new Map();
	for (const doc of docs) {
		const existing = latest.get(doc.command);
		if (!existing || doc.level > existing.level) latest.set(doc.command, doc);
	}
	return [...latest.values()].sort((a, b) => a.command.localeCompare(b.command));
}

function currentCompatibilityLevel() {
	const match = readdirSync(libDir)
		.filter((filename) => filename.endsWith(".ts"))
		.map((filename) => readFileSync(join(libDir, filename), "utf8"))
		.map((sourceText) => /\bexport const CURRENT_COMPATIBILITY_LEVEL = ([0-9]+);/.exec(sourceText))
		.find(Boolean);
	if (!match) fail("could not read CURRENT_COMPATIBILITY_LEVEL from src/lib");
	return Number.parseInt(match[1], 10);
}

function isExplicitlyDeprecated(doc) {
	// A replacement is the deprecation: naming one is the only way to mark a
	// command dead, so the mark and the advice cannot drift apart.
	return doc.useInstead.trim() !== "";
}

function isInternalCommand(doc) {
	return doc.command.startsWith("_");
}

function commandRows(docs) {
	return docs.map((doc) => [
		markdownLink(code(`${doc.command}@${doc.level}`), doc.relPath),
		code(usageForReadme(doc.usage)),
		doc.gist,
	]);
}

function deprecatedRows(docs) {
	return docs.map((doc) => [
		markdownLink(code(`${doc.command}@${doc.level}`), doc.relPath),
		code(usageForReadme(doc.usage)),
		doc.useInstead,
	]);
}

function commandSections(docs) {
	const invocation = publishedNosediveInvocation();
	return docs.flatMap((doc) => [
		`#### ${markdownLink(doc.title, doc.relPath)}`,
		"",
		"```sh",
		`${invocation} ${doc.command} --help`,
		"```",
		"```md",
		renderCommandHelpText(doc),
		"```",
		"",
	]);
}

export function renderCommandSurface() {
	const currentLevel = currentCompatibilityLevel();
	// The newest doc remains authoritative for a command. If it belongs to a
	// future level, do not revive an older spelling in the current surface.
	const latestDocs = latestDocsByCommand(commandDocs()).filter((doc) => doc.level <= currentLevel);
	const publicDocs = latestDocs.filter((doc) => !isInternalCommand(doc));
	const activeDocs = publicDocs.filter((doc) => !isExplicitlyDeprecated(doc));
	const deprecatedDocs = publicDocs.filter((doc) => isExplicitlyDeprecated(doc));
	const internalDocs = latestDocs.filter(
		(doc) => isInternalCommand(doc) && !isExplicitlyDeprecated(doc),
	);

	const lines = [
		beginMarker,
		"<!-- Generated by `npm run commands:surface`; do not edit by hand. -->",
		"",
		"Command docs are the index into implementation: start at the linked doc, then follow its adapter entrypoint and compatibility breadcrumbs. A command whose latest doc belongs to an upcoming level is omitted until that level is released; a current doc remains listed unless it is deprecated.",
		"",
		"`version` and `help` have no command doc; they print the package version and the command list.",
		"",
		"### External Commands",
		"",
		"Invoked directly by humans, or indirectly via agents.",
		"",
		...commandSections(activeDocs),
		"### Internal Commands",
		"",
		"Named with a leading underscore, invoked by `nosedive` itself or by a hook it installs.",
		"",
		"| Command | Usage | What it does |",
		"| --- | --- | --- |",
		...commandRows(internalDocs).map((row) => `| ${row.map(tableCell).join(" | ")} |`),
		"",
		"### Deprecated Commands",
		"",
		"Still functional, so nothing pinned to them breaks. Each names what to reach for now.",
		"",
		"| Command | Usage | Use instead |",
		"| --- | --- | --- |",
		...deprecatedRows(deprecatedDocs).map((row) => `| ${row.map(tableCell).join(" | ")} |`),
		endMarker,
	];
	return lines.join("\n");
}

function replaceGeneratedSurface(readme, generated) {
	const existingRegion = new RegExp(`${beginMarker}[\\s\\S]*?${endMarker}`);
	if (existingRegion.test(readme)) return readme.replace(existingRegion, generated);

	const legacyTable =
		/\| Command \| Doc \| Status \| What it does \|\r?\n\| --- \| --- \| --- \| --- \|\r?\n(?:\| .* \|\r?\n)+/;
	if (legacyTable.test(readme)) return readme.replace(legacyTable, `${generated}\n`);

	fail(
		`COMMANDS.md is missing ${beginMarker} / ${endMarker} markers and no legacy command table was found`,
	);
}

const LEVEL_NAME = /^level-(\d+)$/;

function linkTargetIds(raw, rel) {
	if (!Array.isArray(raw)) return [];
	const ids = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const pairs = Object.entries(entry);
		if (pairs.length !== 1) continue;
		const [target, value] = pairs[0];
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		if (value.rel !== rel) continue;
		const match = /^kb\/([0-9a-f-]{36})\.md$/i.exec(target);
		if (match) ids.push(match[1].toLowerCase());
	}
	return ids;
}

function levelDocs() {
	const docs = [];
	for (const filename of readdirSync(kbDir)
		.filter((name) => name.endsWith(".md"))
		.sort()) {
		const path = join(kbDir, filename);
		const text = read(path);
		const raw = parseFrontmatter(text, filename);
		if (!raw || raw.kind !== "level") continue;
		const name = String(raw.name ?? "");
		const match = LEVEL_NAME.exec(name);
		if (!match) fail(`${filename} level name must be level-<N>, got ${name}`);
		const id = String(raw.id ?? "").toLowerCase();
		if (!id) fail(`${filename} level is missing id`);
		const migrationIds = linkTargetIds(raw.links, "migration");
		docs.push({
			filename,
			relPath: rel(path),
			id,
			name,
			level: Number.parseInt(match[1], 10),
			gist: String(raw.gist ?? ""),
			migrationDocId: migrationIds[0],
		});
	}
	docs.sort((a, b) => a.id.localeCompare(b.id));
	for (const [position, doc] of docs.entries()) {
		if (doc.level !== position) {
			fail(
				`${doc.filename} is named ${doc.name} but sits at position ${position}; levels are contiguous from 0 and their ids sort in level order`,
			);
		}
	}
	return docs;
}

function migrationSection(level) {
	return [
		"### Migration",
		"",
		`Upgrading to ${level.name} requires running a migration: see [the migration doc](kb/${level.migrationDocId}.md).`,
	].join("\n");
}

function renderLevels() {
	const docs = levelDocs();
	if (docs.length === 0) fail("no kind: level docs found in kb/");
	const level = currentCompatibilityLevel();
	const current = docs.find((doc) => doc.level === level);
	if (!current) fail(`no kind: level doc declares CURRENT_COMPATIBILITY_LEVEL=${level}`);
	const future = docs.filter((doc) => doc.level > level);
	const earlier = docs.filter((doc) => doc.level < level).reverse();

	const lines = [
		levelsBeginMarker,
		"<!-- Generated by `npm run commands:surface`; do not edit by hand. -->",
		"",
		"## Where we are now",
		"",
		`### ${markdownLink(`Level ${current.level}`, current.relPath)}`,
		"",
		current.gist,
		"",
		current.migrationDocId ? migrationSection(current) : "**No migration necessary.**",
		"",
		"## Where we are going",
		"",
		...future.flatMap((doc) => [
			`### ${markdownLink(`Level ${doc.level}`, doc.relPath)}`,
			"",
			doc.gist,
			"",
		]),
		"## How we got here",
		"",
		"<details><summary>Earlier levels</summary>",
		"",
		...earlier.map((doc) => `- [Level ${doc.level}](${doc.relPath}) -- ${doc.gist}`),
		"",
		"</details>",
		levelsEndMarker,
	];
	return lines.join("\n");
}

function replaceGeneratedLevels(readme, generated) {
	const existingRegion = new RegExp(`${levelsBeginMarker}[\\s\\S]*?${levelsEndMarker}`);
	if (existingRegion.test(readme)) return readme.replace(existingRegion, generated);
	fail(`COMMANDS.md is missing ${levelsBeginMarker} / ${levelsEndMarker} markers`);
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const target = read(targetPath);
	const generated = renderCommandSurface();
	const withSurface = replaceGeneratedSurface(target, generated);
	const generatedLevels = renderLevels();
	const updated = replaceGeneratedLevels(withSurface, generatedLevels);

	if (checkOnly) {
		if (updated !== target) {
			console.error("COMMANDS.md command surface is stale. Run `npm run commands:surface`.");
			process.exit(1);
		}
		console.log("COMMANDS.md command surface is up to date.");
		return;
	}
	writeFileSync(targetPath, updated, "utf8");
	console.log("Updated COMMANDS.md command surface.");
}

// Importing this module must not rewrite COMMANDS.md: contract-help asks it for the
// surface it would generate, and never for the file on disk.
if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
	main();
}
