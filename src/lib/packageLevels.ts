import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { Migration } from "./bridgeSetupIo.js";
import { CURRENT_COMPATIBILITY_LEVEL } from "./constants.js";
import { formatPath, parseMarkdownDoc } from "./coreParsing.js";
import { packageDocsOfKind, packageRoot } from "./packageBacklog.js";
import { unsafeLinkPath } from "./proveCore.js";

/**
 * A compatibility level, declared by a `kind: level` doc shipped in the package
 * kb. The doc is the release note for the level; a migration is attached only
 * when one must actually run to read the previous level's data.
 */
export interface LevelDoc {
	level: number;
	/** Always `level-<level>`; the name is the declaration of which level this is. */
	name: string;
	docId: string;
	path: string;
	gist: string;
	/** Target of the single `rel: migration` link, if this level has one. */
	migrationDocId?: string;
}

const LEVEL_NAME = /^level-(\d+)$/;

function linkTargetIds(raw: unknown, rel: string): string[] {
	if (!Array.isArray(raw)) return [];
	const ids: string[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const pairs = Object.entries(entry as Record<string, unknown>);
		if (pairs.length !== 1) continue;
		const [target, value] = pairs[0]!;
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		if ((value as Record<string, unknown>).rel !== rel) continue;
		const match = /^kb\/([0-9a-f-]{36})\.md$/i.exec(target);
		if (match) ids.push(match[1]!.toLowerCase());
	}
	return ids;
}

/**
 * Every level the package declares, in level order.
 *
 * The name is load-bearing, so it is validated the way command doc names are:
 * levels are contiguous integers from 0, and because the ids are minted at the
 * instant each level came into being they already sort into that same order. A
 * doc whose `name` disagrees with its position in that ordering is an error.
 */
export function packageLevelDocs(): LevelDoc[] {
	const kbDir = join(packageRoot(), "kb");
	const docs = packageDocsOfKind("level")
		.map((doc) => {
			const path = join(kbDir, doc.filename);
			const parsed = parseMarkdownDoc(doc.content, formatPath(path));
			const id = parsed.fm.scalars.id;
			const name = parsed.fm.scalars.name ?? "";
			const match = LEVEL_NAME.exec(name);
			if (!id) throw new Error(`level ${formatPath(path)} is missing id`);
			if (!match) throw new Error(`level ${formatPath(path)} name must be level-<N>, got ${name}`);
			const migrations = linkTargetIds(parsed.fm.raw.links, "migration");
			if (migrations.length > 1) {
				throw new Error(`level ${formatPath(path)} declares more than one rel: migration link`);
			}
			return {
				level: Number.parseInt(match[1]!, 10),
				name,
				docId: id,
				path,
				gist: parsed.fm.scalars.gist ?? "",
				migrationDocId: migrations[0],
			};
		})
		.sort((a, b) => a.docId.localeCompare(b.docId));

	for (const [position, doc] of docs.entries()) {
		if (doc.level !== position) {
			throw new Error(
				`level ${formatPath(doc.path)} is named level-${doc.level} but sits at position ${position}; ` +
					`levels are contiguous from 0 and their ids sort in level order`,
			);
		}
	}
	return docs;
}

export function packageLevelDoc(level: number): LevelDoc | undefined {
	return packageLevelDocs().find((doc) => doc.level === level);
}

/**
 * The migration a level links, resolved against the package kb. A level with no
 * `rel: migration` is a bump, not an error: nothing about the previous level's
 * data needs rewriting to be readable here.
 */
export function levelMigration(level: LevelDoc): Migration | undefined {
	if (!level.migrationDocId) return undefined;
	const path = join(packageRoot(), "kb", `${level.migrationDocId}.md`);
	if (!existsSync(path)) {
		throw new Error(
			`level ${formatPath(level.path)} links migration ${level.migrationDocId}, which is not in the package kb`,
		);
	}
	const parsed = parseMarkdownDoc(readFileSync(path, "utf8"), formatPath(path));
	const scriptRelPath = parsed.fm.nested.meta?.script;
	if (
		!scriptRelPath ||
		!scriptRelPath.startsWith("kb/artifacts/") ||
		isAbsolute(scriptRelPath) ||
		unsafeLinkPath(scriptRelPath)
	) {
		throw new Error(
			`migration ${formatPath(path)} must set meta.script to a safe repo-root kb/artifacts path`,
		);
	}
	return {
		fromLevel: level.level - 1,
		toLevel: level.level,
		docId: level.migrationDocId,
		scriptRelPath,
		summary: parsed.fm.scalars.gist ?? "",
	};
}

/** The level docs a bridge at `fromLevel` has not yet declared, up to `toLevel`. */
export function levelsInGap(fromLevel: number, toLevel: number): LevelDoc[] {
	const docs = packageLevelDocs();
	const gap: LevelDoc[] = [];
	for (let level = fromLevel + 1; level <= toLevel; level += 1) {
		const doc = docs.find((candidate) => candidate.level === level);
		if (!doc) {
			throw new Error(
				`no kind: level doc for compatibility level ${level} in the installed nosedive package`,
			);
		}
		gap.push(doc);
	}
	return gap;
}

/** Every migration that must actually run to carry a bridge from `fromLevel` to `toLevel`. */
export function migrationsInGap(fromLevel: number, toLevel: number): Migration[] {
	return levelsInGap(fromLevel, toLevel)
		.map((doc) => levelMigration(doc))
		.filter((migration): migration is Migration => migration !== undefined);
}

/**
 * True when the package cannot read a bridge at `bridgeLevel` without a
 * migration running first. This is the only axis a refusal may key off: a gap
 * made only of migration-free levels costs the bridge nothing but a one-line
 * config diff, which the next `seed` writes anyway.
 */
export function bridgeNeedsMigration(bridgeLevel: number): boolean {
	if (bridgeLevel >= CURRENT_COMPATIBILITY_LEVEL) return false;
	return migrationsInGap(bridgeLevel, CURRENT_COMPATIBILITY_LEVEL).length > 0;
}

/**
 * The refusal a contracted command owes a bridge whose data this package cannot
 * read, or `undefined` when it can. It names the levels in the gap, because
 * "level 1" on its own tells a pilot nothing about what they are missing.
 */
export function levelGateError(bridgeLevel: number): Error | undefined {
	if (!bridgeNeedsMigration(bridgeLevel)) return undefined;
	const levels = levelsInGap(bridgeLevel, CURRENT_COMPATIBILITY_LEVEL)
		.map((level) => `  ${level.name}: ${level.gist}`)
		.join("\n");
	return new Error(
		`bridge is at compatibility level ${bridgeLevel}; run \`nosedive seed\` ` +
			`to migrate it to level ${CURRENT_COMPATIBILITY_LEVEL}\n${levels}`,
	);
}

export interface BridgeLevelDrift {
	bridgeLevel: number;
	/** Blocking drift is refused everywhere else, so preflight must fail too -- it just fails better. */
	blocking: boolean;
	/** One line for the bridge status block. */
	line: string;
	/** The level-by-level detail, printed only when the drift blocks. */
	detail?: string;
}

/**
 * What preflight says about the gap between the bridge's level and the
 * package's. Every other command is silent about this: a warning printed when
 * nothing is wrong teaches people to ignore warnings, and preflight runs once
 * per session, which makes it the earliest honest place to say so.
 */
export function describeBridgeLevelDrift(bridgeLevel: number): BridgeLevelDrift {
	const current = CURRENT_COMPATIBILITY_LEVEL;
	if (bridgeLevel === current) {
		return { bridgeLevel, blocking: false, line: `nosedive-compatibility-level: ${bridgeLevel}` };
	}
	if (bridgeLevel > current) {
		return {
			bridgeLevel,
			blocking: false,
			line:
				`nosedive-compatibility-level: ${bridgeLevel} (this nosedive is at ${current}; ` +
				`the bridge has been seeded by a newer package -- upgrade rather than re-seeding)`,
		};
	}

	const gap = levelsInGap(bridgeLevel, current);
	const migrations = gap.filter((level) => levelMigration(level) !== undefined);
	if (migrations.length === 0) {
		return {
			bridgeLevel,
			blocking: false,
			line:
				`nosedive-compatibility-level: ${bridgeLevel} (this nosedive is at ${current}; ` +
				`nothing to migrate, the next \`nosedive seed\` bumps the line)`,
		};
	}
	return {
		bridgeLevel,
		blocking: true,
		line: `nosedive-compatibility-level: ${bridgeLevel} (this nosedive is at ${current})`,
		detail: [
			`bridge is at compatibility level ${bridgeLevel} and this nosedive is at ${current}; ` +
				`run \`nosedive seed\` before working.`,
			"",
			...gap.map(
				(level) => `  ${level.name}${levelMigration(level) ? " (migration)" : ""}: ${level.gist}`,
			),
		].join("\n"),
	};
}
