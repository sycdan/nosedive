import { existsSync } from "node:fs";

import { helmContext, readableSource } from "./helm.js";
import { bridgeView } from "./helmView.js";
import { loadKbDocs } from "./kbDocs.js";

interface SearchDoc {
	id: string;
	name: string;
	title: string;
	gist: string;
}

export interface HelmSearch {
	groups: Array<{
		repoId: string;
		repoName: string;
		kind: string;
		docs: SearchDoc[];
		more: number;
	}>;
	unsearched: string[];
}

/** Search the same scoped checkouts the context tree can read, without hydrating any. */
export function helmSearch(
	cwd: string,
	query: string,
	rootId: string,
	featId?: string,
	repoId?: string,
	diveId?: string,
): HelmSearch | undefined {
	const result: HelmSearch = { groups: [], unsearched: [] };
	const text = query.trim().toLowerCase();
	if (text.length < 2) return result;
	const context = helmContext(cwd, rootId, featId, repoId, diveId);
	if (!context) return undefined;
	const view = bridgeView(cwd);
	const words = text.split(/\s+/);
	for (const repo of context.repos.filter(
		(repo) => repo.inScope && (!repoId || repo.id === repoId),
	)) {
		const doc = view.docs.find((doc) => doc.id === repo.id && doc.kind === "repo");
		const source = doc && readableSource(view, doc);
		if (!source) {
			result.unsearched.push(repo.name);
			continue;
		}
		// A checkout with no kb, as many repos have, holds nothing to find.
		if (!existsSync(source.kbDir)) continue;
		const kinds = new Map<string, SearchDoc[]>();
		for (const doc of loadKbDocs(source.kbDir, source.root)) {
			const found = { id: doc.id, name: doc.name, title: doc.h1 || doc.name, gist: doc.gist };
			const haystack = Object.values(found).join("\n").toLowerCase();
			if (!words.every((word) => haystack.includes(word))) continue;
			const docs = kinds.get(doc.kind) ?? [];
			docs.push(found);
			kinds.set(doc.kind, docs);
		}
		for (const [kind, docs] of [...kinds].sort(([a], [b]) => a.localeCompare(b)))
			result.groups.push({
				repoId: repo.id,
				repoName: repo.name,
				kind,
				docs: docs.slice(0, 20),
				more: Math.max(0, docs.length - 20),
			});
	}
	return result;
}
