import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import { builtinKindPath } from "./builtinKinds.js";
import { formatPath, readNosediveRc, toPosixPath } from "./coreParsing.js";
import { loadKbDocs, type ScopeRef } from "./kbDocs.js";
import { splitRepoRef } from "./kbRefs.js";
import { isBridge, type KindSource } from "./kinds.js";
import { mayLinkRepo, readRepoFile } from "./repoLinks.js";

const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i;
const KB_DOC = /^(.*)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;

/**
 * Refuses a links patch that adds or changes a link crud cannot resolve.
 * `targets` is `patch` as `patchTargets` resolved it, key for key. A removal
 * (null) and a URL are not checked; with `replace` the patch is the whole
 * block, so every entry is checked.
 *
 * A bare kb doc ref names the nearest copy: the linking doc's own repo, then
 * the bridge, then the one other repo in play that holds it -- more than one
 * is ambiguous. A `<repo-quid>:<path>` ref is read where `readRepoFile` reads
 * it, and only into a repo the linking doc scopes, or the bridge.
 */
export function checkLinkTargets(
	patch: Record<string, unknown>,
	targets: Record<string, unknown>,
	source: KindSource,
	scopes: ScopeRef[],
	inPlay: KindSource[],
): void {
	const rc = readNosediveRc(process.cwd());
	const bridge = inPlay.find(isBridge) ?? {
		id: rc.bridge,
		name: "bridge",
		root: rc.bridgeDir,
		kbDir: rc.kbDir!,
	};
	const kbRel = toPosixPath(relative(source.root, source.kbDir)) || ".";
	const resolved = Object.keys(targets);
	const entries = Object.entries(patch)
		.map(([key, value], i) => ({ key, value, path: resolved[i]! }))
		.filter(({ value, path }) => value !== null && !URL_TARGET.test(path));
	const missing: string[] = [];
	const refused: string[] = [];
	for (const { key, path } of entries) {
		const builtin = KB_DOC.exec(toPosixPath(splitRepoRef(path)?.path ?? path));
		if (builtin?.[1] === "kb" && builtinKindPath(builtin[2]!.toLowerCase())) continue;
		const qualified = splitRepoRef(path);
		if (qualified && qualified.repo !== source.id) {
			const problem = repoLinkProblem(rc, qualified, scopes, source, bridge);
			if (problem) (problem.missing ? missing : refused).push(`${key} (${problem.text})`);
			continue;
		}
		const local = qualified ? qualified.path : path;
		if (existsSync(join(source.root, local))) continue;
		const doc = KB_DOC.exec(toPosixPath(local));
		if (!doc || doc[1] !== kbRel) {
			missing.push(`${key} (${formatPath(join(source.root, local))})`);
			continue;
		}
		const file = `${doc[2]!.toLowerCase()}.md`;
		if (existsSync(join(bridge.kbDir, file))) continue;
		const holders = inPlay.filter(
			(repo) =>
				repo.root !== source.root &&
				repo.root !== bridge.root &&
				existsSync(join(repo.kbDir, file)),
		);
		if (holders.length > 1)
			refused.push(
				`${key} is in more than one repo in play: ${holders.map((repo) => repo.name).join(", ")}; ` +
					`name one as <repo-quid>:kb/${file}`,
			);
		else if (holders.length === 0) missing.push(`${key} (${formatPath(join(source.root, local))})`);
	}
	if (refused.length > 0) throw new Error(`cannot link:\n  ${refused.join("\n  ")}`);
	if (missing.length > 0) throw new Error(`no doc to link to:\n  ${missing.join("\n  ")}`);
}

function repoLinkProblem(
	rc: ReturnType<typeof readNosediveRc>,
	ref: { repo: string; path: string },
	scopes: ScopeRef[],
	source: KindSource,
	bridge: KindSource,
): { text: string; missing: boolean } | undefined {
	if (!mayLinkRepo(rc, scopes, source.id, ref.repo))
		return { text: `the doc does not scope repo ${ref.repo}; scope it first`, missing: false };
	if (ref.repo === rc.bridge) {
		const file = join(bridge.root, ref.path);
		return existsSync(file) ? undefined : { text: formatPath(file), missing: true };
	}
	const repo = loadKbDocs(rc.kbDir!, rc.bridgeDir).find(
		(doc) => doc.id === ref.repo && doc.kind === "repo",
	);
	if (!repo) return { text: `no repo ${ref.repo} in the bridge kb`, missing: true };
	if (readRepoFile(rc, repo, ref.path, true)) return undefined;
	return { text: `no ${ref.path} in ${repo.name}`, missing: true };
}
