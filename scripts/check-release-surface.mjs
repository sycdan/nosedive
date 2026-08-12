import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { commandDocId, commandEntrypointName, commandImplId } from "./command-identifiers.mjs";

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

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function linkIdsByRel(doc, rel) {
	const ids = [];
	for (const { target, value } of linkEntries(doc.raw.links)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		if (value.rel === rel) {
			const id = kbDocIdFromTarget(target);
			if (id) ids.push(id);
		}
	}
	return ids;
}

function isExplicitlyDeprecated(doc) {
	return (
		/^deprecated\b/i.test(String(doc.raw.gist ?? "").trim()) ||
		/^deprecated\b/i.test(String(doc.body ?? "").trim())
	);
}

function validatePackageLinks(raw, filename) {
	for (const { target } of linkEntries(raw.links)) {
		const targetPath = String(target ?? "").split("#")[0];
		/**
		 * An https target is context, not content: a pull request, an issue, a
		 * spec. Nothing in the package resolves it, so there is nothing to check
		 * beyond the scheme -- and requiring it to be a kb path would mean the
		 * package could never cite anything outside itself.
		 */
		if (targetPath.startsWith("https://")) continue;
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
		fail(`${filename} command adapter must live in meta.adapter, not links`);
	}
	if (/^  processors:/m.test(frontmatter)) {
		fail(`${filename} command must use meta.adapter, not meta.processors`);
	}
}

const commandDocs = [];
const migrationDocs = new Map();
const levelDocs = [];
const packageDocsById = new Map();

function uuidShaped(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

for (const filename of readdirSync(kbDir)
	.filter((name) => name.endsWith(".md"))
	.sort()) {
	const path = join(kbDir, filename);
	const text = readFileSync(path, "utf8");
	const raw = frontmatter(text, filename);
	if (!raw || raw.kind === undefined) continue;
	validatePackageLinks(raw, filename);
	if (typeof raw.id === "string") packageDocsById.set(raw.id.toLowerCase(), { filename, raw });

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
		if (raw.meta?.handler !== undefined) {
			fail(`${filename} command must use meta.adapter and meta.entrypoint, not meta.handler`);
		}
		// Omitting the trigger makes a command human-only, and leaves it off the
		// agent-facing surface seed writes.
		if (!match[1].startsWith("_")) {
			const useWhen = raw.meta?.["agents-use-when"];
			if (useWhen !== undefined && (typeof useWhen !== "string" || useWhen.trim() === "")) {
				fail(`${filename} command meta.agents-use-when must be non-empty when present`);
			} else if (typeof useWhen === "string" && /\s{2,}|\r|\n/.test(useWhen)) {
				fail(`${filename} command meta.agents-use-when must be a single line`);
			}
		}
		// A single bound gets its documented default at execution time.
		const minimumEffort = raw.meta?.["minimum-effort"];
		const maximumEffort = raw.meta?.["maximum-effort"];
		if (minimumEffort !== undefined || maximumEffort !== undefined) {
			const minimum =
				minimumEffort === undefined
					? 0
					: parseLevel(minimumEffort, `${filename} meta.minimum-effort`);
			const maximum =
				maximumEffort === undefined
					? undefined
					: parseLevel(maximumEffort, `${filename} meta.maximum-effort`);
			if (minimum !== undefined && maximum !== undefined && maximum < minimum) {
				fail(`${filename} command meta.maximum-effort is below meta.minimum-effort`);
			}
		}

		const level = Number.parseInt(match[2], 10);
		const expectedEntrypoint = commandEntrypointName(match[1], level);
		if (typeof raw.meta?.entrypoint !== "string" || raw.meta.entrypoint.trim() === "") {
			fail(`${filename} command must have meta.entrypoint`);
		} else if (raw.meta.entrypoint !== expectedEntrypoint) {
			fail(`${filename} command meta.entrypoint must be ${expectedEntrypoint}`);
		}
		if (typeof raw.meta?.adapter !== "string" || !raw.meta.adapter.startsWith("kb/artifacts/")) {
			fail(`${filename} command must have meta.adapter as a repo-root kb/artifacts path`);
		} else {
			const adapterPath = join(root, raw.meta.adapter);
			if (!existsSync(adapterPath)) {
				fail(`${filename} adapter does not exist: ${raw.meta.adapter}`);
			} else {
				const adapterText = readFileSync(adapterPath, "utf8");
				const exportPattern = new RegExp(
					`export\\s+async\\s+function\\s+${escapeRegExp(expectedEntrypoint)}\\s*\\(\\s*value\\s*,\\s*ctx\\s*\\)`,
				);
				if (!exportPattern.test(adapterText)) {
					fail(`${filename} adapter must export async function ${expectedEntrypoint}(value, ctx)`);
				}
				if (/\bctx\.invoke\s*\(/.test(adapterText)) {
					fail(`${filename} adapter must call ctx.impl, not ctx.invoke: ${raw.meta.adapter}`);
				}
				const functionPattern = new RegExp(
					`export\\s+async\\s+function\\s+${escapeRegExp(expectedEntrypoint)}\\s*\\(\\s*value\\s*,\\s*ctx\\s*\\)\\s*{([\\s\\S]*?)\\n}`,
				);
				const functionBody = functionPattern.exec(adapterText)?.[1] ?? "";
				const implMatches = [
					...functionBody.matchAll(/\bctx\.impl\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g),
				];
				const expectedImplId = commandImplId(expectedEntrypoint);
				if (implMatches.length === 0) {
					fail(`${filename} adapter ${expectedEntrypoint} must call ctx.impl.${expectedImplId}`);
				}
				for (const match of implMatches) {
					const implAlias = match[1] ?? "";
					if (implAlias !== expectedImplId) {
						fail(
							`${filename} adapter ${expectedEntrypoint} must call deterministic impl ${expectedImplId}, not ${implAlias}`,
						);
					}
				}
				const implPath = join(root, "src", "impl", `${expectedImplId}.ts`);
				if (!existsSync(implPath)) {
					fail(`${filename} deterministic impl file is missing: src/impl/${expectedImplId}.ts`);
				}
			}
		}
		commandDocs.push({
			filename,
			id: raw.id,
			name: raw.name,
			command: match[1],
			level,
			raw,
			body: text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""),
		});
	}

	if (raw.kind === "migration") {
		if (/^---\r?\n[\s\S]*?\r?\n\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) {
			fail(`${filename} migration frontmatter must not contain blank lines`);
		}
		if (typeof raw.id !== "string" || raw.id.trim() === "") {
			fail(`${filename} migration must have a non-empty id`);
			continue;
		}
		// A migration is reached only through a level's `rel: migration` link, and
		// carries a script only while it is live: a retired one keeps its prose as
		// its level's release note and must not stay runnable.
		if (raw.meta?.["from-level"] !== undefined || raw.meta?.["to-level"] !== undefined) {
			fail(
				`${filename} migration must not carry meta.from-level/meta.to-level; a migration linked from level-N migrates N-1 -> N by position`,
			);
		}
		if (raw.meta?.script !== undefined) {
			if (typeof raw.meta.script !== "string" || !raw.meta.script.startsWith("kb/artifacts/")) {
				fail(`${filename} migration meta.script must be a repo-root kb/artifacts path`);
			} else if (!existsSync(join(root, raw.meta.script))) {
				fail(`${filename} migration meta.script does not exist: ${raw.meta.script}`);
			}
		}
		migrationDocs.set(raw.id, { filename, id: raw.id, script: raw.meta?.script });
	}

	if (raw.kind === "level") {
		const match = /^level-([0-9]+)$/.exec(String(raw.name ?? ""));
		if (typeof raw.id !== "string" || !uuidShaped(raw.id)) {
			fail(`${filename} level must have a UUID-shaped id`);
			continue;
		}
		if (!match) {
			fail(`${filename} level name must look like level-<N>, got ${raw.name}`);
			continue;
		}
		if (filename !== `${raw.id}.md`) fail(`${raw.name} filename must be ${raw.id}.md`);
		const migrations = linkIdsByRel({ raw }, "migration");
		if (migrations.length > 1) {
			fail(`${raw.name} declares more than one rel: migration link`);
		}
		levelDocs.push({
			filename,
			id: raw.id.toLowerCase(),
			name: raw.name,
			level: Number.parseInt(match[1], 10),
			migrationId: migrations[0],
			raw,
		});
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

	for (const errorId of linkIdsByRel(doc, "throws")) {
		const errorDoc = packageDocsById.get(errorId);
		if (!errorDoc) {
			fail(`${doc.name} has rel=throws ${errorId}, but no packaged doc has that id`);
		} else if (errorDoc.raw.kind !== "memo") {
			fail(`${doc.name} rel=throws target ${errorId} must be kind: memo`);
		} else if (!linkIdsByRel({ raw: errorDoc.raw }, "thrown-by").includes(doc.id)) {
			fail(`${doc.name} rel=throws target ${errorId} must link rel=thrown-by back to ${doc.id}`);
		}
	}

	const commandDocsForName = docsByCommand.get(doc.command) ?? [];
	commandDocsForName.push(doc);
	docsByCommand.set(doc.command, commandDocsForName);

	const key = `${doc.command}@${doc.level}`;
	const sameLevelDocs = docsByCommandLevel.get(key) ?? [];
	sameLevelDocs.push(doc);
	docsByCommandLevel.set(key, sameLevelDocs);
}

for (const [memoId, memoDoc] of packageDocsById) {
	if (memoDoc.raw.kind !== "memo") continue;
	for (const commandId of linkIdsByRel({ raw: memoDoc.raw }, "thrown-by")) {
		const commandDoc = commandDocs.find((doc) => doc.id === commandId);
		if (!commandDoc) {
			fail(
				`${memoDoc.filename} has rel=thrown-by ${commandId}, but no packaged command has that id`,
			);
		} else if (!linkIdsByRel(commandDoc, "throws").includes(memoId)) {
			fail(
				`${memoDoc.filename} rel=thrown-by target ${commandId} must link rel=throws back to ${memoId}`,
			);
		}
	}
}

// Level ids are minted at the instant each level came into being, so they
// already sort into level order. The name is the declaration of which level a
// doc is, and a name that disagrees with that ordering is an error, not a
// warning -- the whole migration loop reads levels by name.
const levelsById = [...levelDocs].sort((a, b) => a.id.localeCompare(b.id));
for (const [position, doc] of levelsById.entries()) {
	if (doc.level !== position) {
		fail(
			`${doc.filename} is named ${doc.name} but sits at position ${position} in minted order; levels are contiguous from 0 and their ids must sort in level order`,
		);
	}
}
const levelsByLevel = new Map();
for (const doc of levelDocs) {
	if (levelsByLevel.has(doc.level)) {
		fail(`${doc.name} is ambiguous: ${levelsByLevel.get(doc.level).filename}, ${doc.filename}`);
		continue;
	}
	levelsByLevel.set(doc.level, doc);
}
for (let level = 0; level <= currentLevel; level += 1) {
	if (!levelsByLevel.has(level)) fail(`no kind: level doc declares level-${level}`);
}
for (const doc of levelDocs) {
	if (doc.level > currentLevel && doc.raw.meta?.future !== true) {
		fail(`${doc.name} is ahead of CURRENT_COMPATIBILITY_LEVEL=${currentLevel}`);
	}
	if (!doc.migrationId) continue;
	const migration = migrationDocs.get(doc.migrationId);
	if (!migration) {
		fail(
			`${doc.name} links rel: migration ${doc.migrationId}, but no packaged migration has that id`,
		);
	} else if (!migration.script) {
		fail(`${doc.name} links rel: migration ${migration.filename}, which has no meta.script to run`);
	}
}

for (const [key, docs] of docsByCommandLevel) {
	if (docs.length > 1) {
		fail(`${key} is ambiguous: ${docs.map((doc) => doc.filename).join(", ")}`);
	}
}

for (const doc of commandDocs
	.filter((doc) => isExplicitlyDeprecated(doc))
	.sort((a, b) => a.name.localeCompare(b.name))) {
	if (doc.level === currentLevel) continue;
	const deprecatedByIds = deprecatedByMigrationIds(doc);
	if (deprecatedByIds.length === 0) {
		fail(
			`${doc.name} is below current level ${currentLevel}; promote it or add a rel=deprecated-by level link`,
		);
		continue;
	}

	let hasValidBoundary = false;
	for (const id of deprecatedByIds) {
		const level = levelDocs.find((candidate) => candidate.id === id);
		if (!level) {
			fail(`${doc.name} has rel=deprecated-by ${id}, but no packaged kind: level doc has that id`);
			continue;
		}
		if (level.level <= doc.level) {
			fail(
				`${doc.name} is deprecated by ${level.name}, which is not above the command's own level ${doc.level}`,
			);
			continue;
		}
		if (level.level > currentLevel) {
			fail(
				`${doc.name} is deprecated by ${level.name}, which is above the current level ${currentLevel}`,
			);
			continue;
		}
		hasValidBoundary = true;
	}

	if (!hasValidBoundary) {
		fail(`${doc.name} has no valid rel=deprecated-by level boundary`);
	}
}

for (const [command, docs] of docsByCommand) {
	const sortedDocs = [...docs].sort((a, b) => a.level - b.level);
	for (let i = 1; i < sortedDocs.length; i += 1) {
		const previous = sortedDocs[i - 1];
		const current = sortedDocs[i];
		if (!previous || !current) continue;

		if (
			current.raw.meta?.adapter === previous.raw.meta?.adapter &&
			current.raw.meta?.entrypoint === previous.raw.meta?.entrypoint
		) {
			fail(
				`${current.name} and ${previous.name} use the same adapter entrypoint; keep one command doc unless behavior changed`,
			);
		}

		if (!linkIdsByRel(current, "supersedes").includes(previous.id)) {
			fail(`${current.name} must link rel=supersedes to previous level ${previous.name}`);
		}
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
