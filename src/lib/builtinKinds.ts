import { existsSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "./packageBacklog.js";

/** These schemas are part of nosedive's contract, not bridge-owned documents. */
export const BUILTIN_KIND_IDS = new Set([
	"00000000-0000-70a0-90bd-1d49dc6264b9", // kind
	"00000000-0000-77cb-bcfe-6c9fb07f42ab", // dive
	"00000000-0000-7bb2-8122-2cad84184e09", // memo
	"00000000-0000-7dfa-bfc7-99ba38b8ed1e", // repo
]);

export function builtinKindPath(id: string): string | undefined {
	if (!BUILTIN_KIND_IDS.has(id)) return undefined;
	const path = join(packageRoot(), "kb", `${id}.md`);
	return existsSync(path) ? path : undefined;
}
