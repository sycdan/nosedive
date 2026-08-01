import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSeq, parseDocument } from "yaml";

import {
	NosediveRc,
	formatPath,
	parseMarkdownFrontmatter,
	splitMarkdownFrontmatter,
	stringifyYaml,
} from "./coreParsing.js";
import { EffortRepo, KbDoc, readActiveDiveId } from "./kbDocs.js";
import { parseScopeRefs } from "./proveHostRender.js";
import { writeFileAtomic } from "./renderPlan.js";

export function effortDocs(kbDocs: KbDoc[]): KbDoc[] {
	return kbDocs.filter((doc) => doc.kind === "effort");
}

export function resolveEffortDoc(kbDocs: KbDoc[], rc: NosediveRc, effortRef: string): KbDoc {
	const efforts = effortDocs(kbDocs);
	const byId = efforts.filter((doc) => doc.id === effortRef);
	if (byId.length === 1) return byId[0];

	const normalizedRef = effortRef.replaceAll("\\", "/");
	const pathCandidates = [
		resolve(process.cwd(), effortRef),
		resolve(rc.bridgeDir, effortRef),
		rc.kbDir ? resolve(rc.kbDir, effortRef) : undefined,
	].filter((candidate): candidate is string => candidate !== undefined);
	const byPath = efforts.filter(
		(doc) =>
			doc.relPath.replaceAll("\\", "/") === normalizedRef ||
			pathCandidates.some((candidate) => resolve(doc.path) === candidate),
	);
	if (byPath.length === 1) return byPath[0];
	if (byPath.length > 1) {
		throw new Error(
			`effort path is ambiguous: ${effortRef} (${byPath.map((doc) => doc.id).join(", ")})`,
		);
	}

	const byName = efforts.filter((doc) => doc.name === effortRef);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		throw new Error(
			`effort name is ambiguous: ${effortRef} (${byName.map((doc) => doc.id).join(", ")})`,
		);
	}
	throw new Error(`effort not found: ${effortRef}`);
}

export function resolveActiveEffortDoc(kbDocs: KbDoc[], rc: NosediveRc): KbDoc {
	if (rc.current.effort) return resolveEffortDoc(kbDocs, rc, rc.current.effort);

	const activeDiveId = readActiveDiveId(rc.workspaceDir);
	const activeDive = activeDiveId
		? kbDocs.find((doc) => doc.kind === "dive" && doc.id === activeDiveId)
		: undefined;
	if (activeDive?.effortRef) return resolveEffortDoc(kbDocs, rc, activeDive.effortRef);

	throw new Error("add-repo.effort requires an active effort");
}

export function formatEffortScopeEntry(
	repoId: string,
	ref: string | undefined,
	readOnly: boolean,
): string {
	return `${repoId}${ref ? `@${ref}` : ""}:${readOnly ? "ro" : "rw"}`;
}

export function appendRepoScopeToEffort(path: string, repo: EffortRepo): string {
	const text = readFileSync(path, "utf8");
	const rawScopes = parseMarkdownFrontmatter(text, path).raw.scopes;
	const existing = parseScopeRefs(rawScopes, path);
	if (existing.some((entry) => entry.repoId === repo.id)) {
		throw new Error(`effort already includes scope ${repo.id}: ${formatPath(path)}`);
	}

	const frontmatter = splitMarkdownFrontmatter(text, path);
	const entry = formatEffortScopeEntry(repo.id, repo.ref, repo.readOnly);
	const doc = parseDocument(frontmatter.yaml);
	if (doc.errors.length > 0)
		throw new Error(
			`invalid YAML in frontmatter in ${path}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);

	const scopeValue: Record<string, string> = {};
	if (repo.ref) scopeValue.ref = repo.ref;
	scopeValue.mode = repo.readOnly ? "ro" : "rw";
	const scopeEntry = { [repo.id]: scopeValue };
	const scopes = doc.get("scopes", true);
	if (scopes === undefined || scopes === null) {
		doc.set("scopes", [scopeEntry]);
	} else if (isSeq(scopes)) {
		scopes.add(scopeEntry);
	} else {
		throw new Error(`invalid effort scopes in ${path}: expected a YAML list`);
	}

	const yaml = stringifyYaml(doc);
	writeFileAtomic(path, ["---", yaml.trimEnd(), "---", frontmatter.body].join("\n"));
	return entry;
}
