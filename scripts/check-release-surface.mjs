import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kbDir = join(root, "kb");
const sourceText = readFileSync(join(root, "src", "nosedive.ts"), "utf8");
const currentLevelMatch = /\bconst CURRENT_COMPATIBILITY_LEVEL = ([0-9]+);/.exec(sourceText);

if (!currentLevelMatch) {
	throw new Error("could not read CURRENT_COMPATIBILITY_LEVEL from src/nosedive.ts");
}

const currentLevel = Number.parseInt(currentLevelMatch[1], 10);
const failures = [];

function fail(message) {
	failures.push(message);
}

function frontmatter(text, label) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return undefined;
	try {
		return YAML.parse(match[1]) ?? {};
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		fail(`${label} has invalid YAML frontmatter: ${detail}`);
		return undefined;
	}
}

function parseLevel(value, label) {
	const level = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isInteger(level) || level < 0 || String(value) !== String(level)) {
		fail(`${label} must be a non-negative integer`);
		return undefined;
	}
	return level;
}

function deprecatedByMigrationIds(doc) {
	const links = Array.isArray(doc.raw.links) ? doc.raw.links : [];
	const ids = [];
	for (const link of links) {
		if (!link || typeof link !== "object" || Array.isArray(link)) continue;
		const entries = Object.entries(link);
		if (entries.length !== 1) continue;
		const [id, value] = entries[0];
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		if (value.rel === "deprecated-by") ids.push(id);
	}
	return ids;
}

function commandFrontmatterOrder(text, filename) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) return;
	const frontmatter = match[1];
	if (/^\s*$/m.test(frontmatter)) {
		fail(`${filename} command frontmatter must not contain blank lines`);
	}
	if (/\n\s*usage:\s*\|[-+]?/.test(frontmatter)) {
		fail(`${filename} command usage must be a one-line scalar`);
	}
	const scopesIndex = frontmatter.search(/^scopes:/m);
	const metaIndex = frontmatter.search(/^meta:/m);
	if (scopesIndex === -1) fail(`${filename} command frontmatter must include scopes before meta`);
	if (metaIndex === -1) fail(`${filename} command frontmatter must include meta`);
	if (scopesIndex !== -1 && metaIndex !== -1 && scopesIndex > metaIndex) {
		fail(`${filename} command frontmatter must put scopes before meta`);
	}
	if (/^links:\r?\n(?:[ \t].*\r?\n)*[ \t]+rel: executor$/m.test(frontmatter)) {
		fail(`${filename} command processors must live in meta.processors, not links`);
	}
}

const commandDocs = [];
const migrationDocs = new Map();

for (const filename of readdirSync(kbDir)
	.filter((name) => name.endsWith(".md"))
	.sort()) {
	const path = join(kbDir, filename);
	const text = readFileSync(path, "utf8");
	const raw = frontmatter(text, filename);
	if (!raw || raw.kind === undefined) continue;

	if (raw.kind === "command") {
		commandFrontmatterOrder(text, filename);
		const match = /^(.+)@([0-9]+)$/.exec(String(raw.name ?? ""));
		if (!match) {
			fail(`${filename} command name must look like <command>@<level>`);
			continue;
		}
		if (typeof raw.meta?.usage !== "string" || raw.meta.usage.trim() === "") {
			fail(`${filename} command must have meta.usage`);
		}
		if (/\s{2,}|\r|\n/.test(String(raw.meta?.usage ?? ""))) {
			fail(`${filename} command meta.usage must be a single line`);
		}
		if (!Array.isArray(raw.meta?.processors) || raw.meta.processors.length === 0) {
			fail(`${filename} command must have a non-empty meta.processors list`);
		} else {
			for (const processor of raw.meta.processors) {
				if (typeof processor !== "string" || !processor.startsWith("kb/artifacts/")) {
					fail(`${filename} processor must be a repo-root kb/artifacts path: ${processor}`);
				}
			}
		}
		commandDocs.push({
			filename,
			id: raw.id,
			name: raw.name,
			command: match[1],
			level: Number.parseInt(match[2], 10),
			raw,
		});
	}

	if (raw.kind === "migration") {
		if (/^---\r?\n[\s\S]*?\r?\n\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) {
			fail(`${filename} migration frontmatter must not contain blank lines`);
		}
		const fromLevel = parseLevel(raw.meta?.["from-level"], `${filename} meta.from-level`);
		const toLevel = parseLevel(raw.meta?.["to-level"], `${filename} meta.to-level`);
		if (typeof raw.id !== "string" || raw.id.trim() === "") {
			fail(`${filename} migration must have a non-empty id`);
			continue;
		}
		if (typeof raw.meta?.script !== "string" || !raw.meta.script.startsWith("kb/artifacts/")) {
			fail(`${filename} migration meta.script must be a repo-root kb/artifacts path`);
		}
		if (fromLevel !== undefined && toLevel !== undefined) {
			migrationDocs.set(raw.id, { filename, id: raw.id, fromLevel, toLevel });
		}
	}
}

const docsByCommand = new Map();
const docsByCommandLevel = new Map();

for (const doc of commandDocs) {
	if (doc.level > currentLevel) {
		fail(`${doc.name} is ahead of CURRENT_COMPATIBILITY_LEVEL=${currentLevel}`);
	}

	const commandDocsForName = docsByCommand.get(doc.command) ?? [];
	commandDocsForName.push(doc);
	docsByCommand.set(doc.command, commandDocsForName);

	const key = `${doc.command}@${doc.level}`;
	const sameLevelDocs = docsByCommandLevel.get(key) ?? [];
	sameLevelDocs.push(doc);
	docsByCommandLevel.set(key, sameLevelDocs);
}

for (const [key, docs] of docsByCommandLevel) {
	if (docs.length > 1) {
		fail(`${key} is ambiguous: ${docs.map((doc) => doc.filename).join(", ")}`);
	}
}

for (const [command, docs] of [...docsByCommand.entries()].sort(([a], [b]) => a.localeCompare(b))) {
	const maxLevel = Math.max(...docs.map((doc) => doc.level));
	if (maxLevel >= currentLevel) continue;

	const [latestDoc] = docs.filter((doc) => doc.level === maxLevel);
	const deprecatedByIds = deprecatedByMigrationIds(latestDoc);
	if (deprecatedByIds.length === 0) {
		fail(
			`${latestDoc.name} is below current level ${currentLevel}; promote to ${command}@${currentLevel} or add a rel=deprecated-by migration link`,
		);
		continue;
	}

	let hasValidBoundary = false;
	for (const id of deprecatedByIds) {
		const migration = migrationDocs.get(id);
		if (!migration) {
			fail(
				`${latestDoc.name} has rel=deprecated-by ${id}, but no package migration doc has that id`,
			);
			continue;
		}
		if (migration.fromLevel !== maxLevel) {
			fail(
				`${latestDoc.name} is deprecated by ${id}, but that migration starts at ${migration.fromLevel}; expected ${maxLevel}`,
			);
			continue;
		}
		if (migration.toLevel > currentLevel) {
			fail(
				`${latestDoc.name} is deprecated by ${id}, but that migration ends at ${migration.toLevel}; current level is ${currentLevel}`,
			);
			continue;
		}
		hasValidBoundary = true;
	}

	if (!hasValidBoundary) {
		fail(`${latestDoc.name} has no valid rel=deprecated-by migration boundary`);
	}
}

if (failures.length > 0) {
	console.error("release surface check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log(`release surface check passed for compatibility level ${currentLevel}`);
