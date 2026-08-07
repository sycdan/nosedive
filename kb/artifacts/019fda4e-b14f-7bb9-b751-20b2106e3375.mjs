import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function writeAtomic(path, content) {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, content, "utf8");
	renameSync(temp, path);
}

export function migrate({ bridgeDir }) {
	const kbDir = join(bridgeDir, "kb");
	if (!existsSync(kbDir)) return { featCount: 0 };
	let changed = 0;
	for (const entry of readdirSync(kbDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const path = join(kbDir, entry.name);
		const text = readFileSync(path, "utf8");
		if (!/^kind: effort$/m.test(text)) continue;
		writeAtomic(path, text.replace(/^kind: effort$/m, "kind: feat"));
		changed += 1;
	}
	return { featCount: changed };
}
