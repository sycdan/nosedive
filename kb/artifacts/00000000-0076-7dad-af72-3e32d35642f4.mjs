// Migration script for kb doc 00000000-0061-77ed-a060-f803c8f5aa76.
//
// Converts a legacy single `.nosediverc` bridge config (compatibility level 0)
// into the level-1 checked-in `.nosedive/config.yaml` shape.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";

const KNOWN_BASE_KEYS = [
	"workspace",
	"backlog",
	"kb",
	"home-branch",
	"work-branch-prefix",
	"agents",
];

function writeFileAtomic(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

export function migrate(ctx) {
	const bridgeDir = ctx.bridgeDir;
	const legacyPath = join(bridgeDir, ".nosediverc");
	const legacy = parse(readFileSync(legacyPath, "utf8")) ?? {};

	const remaining = { ...legacy };
	delete remaining["pilot-name"];
	delete remaining["pilot-email"];
	// `current.*` is deprecated transient active-work state (superseded by
	// workspace/.nosedive-ref); it is intentionally dropped, not carried
	// forward into the new shape.
	delete remaining["current"];

	const base = { "compatibility-level": 1 };
	for (const key of KNOWN_BASE_KEYS) {
		if (key in remaining) {
			base[key] = remaining[key];
			delete remaining[key];
		}
	}
	Object.assign(base, remaining); // preserve any other unrecognized keys as-is

	writeFileAtomic(join(bridgeDir, ".nosedive", "config.yaml"), stringify(base));
	rmSync(legacyPath, { force: true });
}
