import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { formatPath } from "./coreParsing.js";
import { gitOutput } from "./gitProcess.js";
import { readKbDoc } from "./kbDocs.js";
import {
	isBridge,
	isShipped,
	loadKinds,
	repoKbDir,
	validateMeta,
	type KindDoc,
	type KindSource,
} from "./kinds.js";

export interface InstanceFailure {
	id: string;
	gist: string;
	path: string;
	errors: string[];
}

/** Every doc of a kind, in the kb of the repo that declares it, whose meta the kind rejects. */
export function instanceFailures(kind: KindDoc): InstanceFailure[] {
	const kbDir = kind.source.kbDir;
	if (!existsSync(kbDir)) return [];
	const kindLine = `kind: ${kind.name}`;
	const failures: InstanceFailure[] = [];
	for (const file of readdirSync(kbDir).filter((name) => name.endsWith(".md"))) {
		const path = join(kbDir, file);
		if (
			!readFileSync(path, "utf8")
				.split(/\r?\n/)
				.some((line) => line.trimEnd() === kindLine)
		)
			continue;
		const doc = readKbDoc(path, kind.source.root);
		const errors = validateMeta(kind, doc.metaRaw);
		if (errors.length > 0) failures.push({ id: doc.id, gist: doc.gist, path: doc.path, errors });
	}
	return failures;
}

/** The kind docs in a repo's kb whose file changed between `since` and HEAD. */
export function changedKinds(source: KindSource, since: string): KindDoc[] {
	const kbRel = relative(source.root, source.kbDir).split("\\").join("/") || ".";
	const names = gitOutput(source.root, ["diff", "--name-only", since, "HEAD", "--", kbRel]) ?? "";
	const changed = new Set(
		names
			.split(/\r?\n/)
			.filter(Boolean)
			.map((name) => resolve(source.root, name)),
	);
	return loadKinds([source]).filter((kind) => changed.has(resolve(kind.path)));
}

/**
 * What `land` must refuse over: every instance, in each scoped repo, of a kind
 * the dive changed that fails the kind's new schema. Adding an optional field
 * strands nothing; removing one, or tightening a constraint, strands every
 * instance that relied on it, and publishing that is publishing broken docs.
 */
export function kindChangeRefusal(
	scopes: Array<{ name: string; root: string; pin: string }>,
): string | undefined {
	const lines: string[] = [];
	const sources = scopes.map((scope) => ({
		name: scope.name,
		root: scope.root,
		kbDir: repoKbDir(scope.root),
	}));
	scopes.forEach((scope, at) => {
		for (const kind of changedKinds(sources[at]!, scope.pin)) {
			// A shipped kind is also every other scoped repo's that takes it rather than define its own.
			const takers = isShipped(kind)
				? sources.filter(
						(other) =>
							!isBridge(other) && !loadKinds([other]).some((own) => own.name === kind.name),
					)
				: [];
			for (const holder of [kind, ...takers.map((source) => ({ ...kind, source }))])
				for (const failure of instanceFailures(holder))
					lines.push(
						`  ${holder.source.name}: ${kind.name} ${failure.id} (${formatPath(failure.path)}): ${failure.errors.join("; ")}`,
					);
		}
	});
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/** land's form of the check: each hydrated, pinned scope, named by its repo doc. */
export function strandedInstancesOnLand(
	scopes: Array<{ scope: { repoId: string; ref?: string }; path: string }>,
	kbDocs: Array<{ id: string; name: string }>,
): string | undefined {
	const refusal = kindChangeRefusal(
		scopes
			.filter(({ scope }) => scope.ref)
			.map(({ scope, path }) => ({
				name: kbDocs.find((doc) => doc.id === scope.repoId)?.name ?? scope.repoId,
				root: path,
				pin: scope.ref!,
			})),
	);
	return refusal
		? `instances of a kind this dive changed fail its new schema; fix them, or the schema:\n${refusal}`
		: undefined;
}
