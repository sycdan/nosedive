import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kbDir = join(root, "kb");
const libDir = join(root, "src", "lib");
const legacyCommandPath = join(libDir, "legacyCommand.ts");
const currentLevelMatch = readdirSync(libDir)
	.filter((filename) => filename.endsWith(".ts"))
	.map((filename) => readFileSync(join(libDir, filename), "utf8"))
	.map((sourceText) => /\bexport const CURRENT_COMPATIBILITY_LEVEL = ([0-9]+);/.exec(sourceText))
	.find(Boolean);
const projectRef = frontmatterish(readFileSync(join(root, ".nosedive-ref"), "utf8"));

if (!currentLevelMatch) {
	throw new Error("could not read CURRENT_COMPATIBILITY_LEVEL from src/lib");
}

const currentLevel = Number.parseInt(currentLevelMatch[1], 10);
const failures = [];

function fail(message) {
	failures.push(message);
}

if (existsSync(legacyCommandPath)) {
	fail("src/lib/legacyCommand.ts must not exist; legacy routes should be explicit command docs");
}

function tsSourceFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...tsSourceFiles(path));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

function lineCount(text) {
	return text.split(/\r?\n/).length;
}

function frontmatterish(text) {
	const values = {};
	for (const line of text.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
		if (match) values[match[1]] = match[2];
	}
	return values;
}

function uuidBytes(uuid) {
	const hex = uuid.replace(/-/g, "");
	if (!/^[0-9a-f]{32}$/i.test(hex)) {
		fail(`.nosedive-ref id must be a UUID: ${uuid}`);
		return Buffer.alloc(16);
	}
	return Buffer.from(hex, "hex");
}

function formatUuid(bytes) {
	const hex = bytes.toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

function namespacedUuid(namespace, name) {
	const bytes = createHash("sha1")
		.update(uuidBytes(namespace))
		.update(name)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return formatUuid(bytes);
}

function commandDocId(command, level) {
	return namespacedUuid(projectRef.id ?? "", `command:${command}@${level}`);
}

function kbDocIdFromTarget(target) {
	const match = /^kb\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i.exec(
		target,
	);
	return match?.[1]?.toLowerCase();
}

function linkEntries(rawLinks) {
	const links = Array.isArray(rawLinks) ? rawLinks : [];
	const entries = [];
	for (const link of links) {
		if (typeof link === "string") {
			entries.push({ target: link, value: undefined });
			continue;
		}
		if (!link || typeof link !== "object" || Array.isArray(link)) continue;
		const linkEntries = Object.entries(link);
		if (linkEntries.length !== 1) continue;
		const [target, value] = linkEntries[0];
		entries.push({ target, value });
	}
	return entries;
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
	const ids = [];
	for (const { target, value } of linkEntries(doc.raw.links)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		if (value.rel === "deprecated-by") {
			const id = kbDocIdFromTarget(target);
			if (id) ids.push(id);
		}
	}
	return ids;
}

function validatePackageLinks(raw, filename) {
	for (const { target } of linkEntries(raw.links)) {
		const targetPath = String(target ?? "").split("#")[0];
		if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetPath)) {
			fail(`${filename} links must use repo-root file paths, not bare UUIDs: ${targetPath}`);
			continue;
		}
		if (
			!targetPath ||
			targetPath.includes("\\") ||
			targetPath.split("/").some((part) => part === "" || part === "..") ||
			!targetPath.startsWith("kb/")
		) {
			fail(`${filename} link target must be a safe repo-root kb/ path: ${target}`);
			continue;
		}
		if (!existsSync(join(root, targetPath))) {
			fail(`${filename} link target does not exist: ${targetPath}`);
		}
	}
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
		fail(`${filename} command handler must live in meta.handler, not links`);
	}
	if (/^  processors:/m.test(frontmatter)) {
		fail(`${filename} command must use meta.handler, not meta.processors`);
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
	validatePackageLinks(raw, filename);

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
		if (typeof raw.meta?.handler !== "string" || !raw.meta.handler.startsWith("kb/artifacts/")) {
			fail(`${filename} command must have meta.handler as a repo-root kb/artifacts path`);
		} else {
			const handlerPath = join(root, raw.meta.handler);
			if (!existsSync(handlerPath)) {
				fail(`${filename} handler does not exist: ${raw.meta.handler}`);
			} else {
				const handlerText = readFileSync(handlerPath, "utf8");
				if (!/export\s+async\s+function\s+handle\s*\(/.test(handlerText)) {
					fail(`${filename} handler must export async function handle(value, ctx)`);
				}
				if (/\bctx\.invoke\s*\(/.test(handlerText)) {
					fail(`${filename} handler must call ctx.impl, not ctx.invoke: ${raw.meta.handler}`);
				}
				if (/\bctx\.impl\.i[0-9a-f]{32}\s*\(/.test(handlerText)) {
					fail(`${filename} handler must use a semantic ctx.impl alias, not a raw impl id`);
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

	const expectedId = commandDocId(doc.command, doc.level);
	if (doc.id !== expectedId) {
		fail(`${doc.name} id must be deterministic command id ${expectedId}`);
	}
	if (doc.filename !== `${expectedId}.md`) {
		fail(`${doc.name} filename must be ${expectedId}.md`);
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

for (const doc of commandDocs
	.filter((doc) => doc.level < currentLevel)
	.sort((a, b) => a.name.localeCompare(b.name))) {
	const deprecatedByIds = deprecatedByMigrationIds(doc);
	if (deprecatedByIds.length === 0) {
		fail(
			`${doc.name} is below current level ${currentLevel}; promote it or add a rel=deprecated-by migration link`,
		);
		continue;
	}

	let hasValidBoundary = false;
	for (const id of deprecatedByIds) {
		const migration = migrationDocs.get(id);
		if (!migration) {
			fail(`${doc.name} has rel=deprecated-by ${id}, but no package migration doc has that id`);
			continue;
		}
		if (migration.fromLevel !== doc.level) {
			fail(
				`${doc.name} is deprecated by ${id}, but that migration starts at ${migration.fromLevel}; expected ${doc.level}`,
			);
			continue;
		}
		if (migration.toLevel > currentLevel) {
			fail(
				`${doc.name} is deprecated by ${id}, but that migration ends at ${migration.toLevel}; current level is ${currentLevel}`,
			);
			continue;
		}
		hasValidBoundary = true;
	}

	if (!hasValidBoundary) {
		fail(`${doc.name} has no valid rel=deprecated-by migration boundary`);
	}
}

for (const path of tsSourceFiles(join(root, "src"))) {
	const lines = lineCount(readFileSync(path, "utf8"));
	if (lines > 500) {
		fail(
			`${path.slice(root.length + 1)} has ${lines} lines; source files must stay at 500 or fewer`,
		);
	}
}

if (failures.length > 0) {
	console.error("release surface check failed:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}

console.log(`release surface check passed for compatibility level ${currentLevel}`);
