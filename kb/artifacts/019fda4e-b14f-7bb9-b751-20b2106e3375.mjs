import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function writeAtomic(path, content) {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, "utf8");
	renameSync(temp, path);
}

/**
 * Only the frontmatter block is rewritten. A body may legitimately contain the
 * line `kind: effort` -- a doc explaining the kind, a fenced example of a doc's
 * shape -- and a migration that edits prose it was never asked about is a
 * migration nobody can safely re-run.
 */
function rekindFrontmatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
	if (!match) return undefined;
	const frontmatter = match[1];
	if (!/^kind: effort[ \t]*$/m.test(frontmatter)) return undefined;
	const rekinded = frontmatter.replace(/^kind: effort[ \t]*$/m, "kind: feat");
	return text.slice(0, match.index) + `---\n${rekinded}\n---${match[2]}` + text.slice(match.index + match[0].length);
}

export function migrate({ bridgeDir }) {
	const kbDir = join(bridgeDir, "kb");
	if (!existsSync(kbDir)) return { featCount: 0 };
	let changed = 0;
	for (const entry of readdirSync(kbDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const path = join(kbDir, entry.name);
		const rekinded = rekindFrontmatter(readFileSync(path, "utf8"));
		if (rekinded === undefined) continue;
		writeAtomic(path, rekinded);
		changed += 1;
	}
	return { featCount: changed };
}
