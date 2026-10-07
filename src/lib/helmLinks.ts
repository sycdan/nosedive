import { readFileSync } from "node:fs";

import { builtinDocPath } from "./builtinKinds.js";
import type { BridgeView } from "./helmView.js";
import { readKbDoc, type KbDoc, type LinkRef } from "./kbDocs.js";
import { splitRepoRef } from "./kbRefs.js";
import { mayLinkRepo, readRepoDoc, readRepoFile } from "./repoLinks.js";

const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A doc's link as helm shows it; `repo` is set on a doc that is not the bridge's. */
export type HelmLink =
	| {
			type: "doc";
			target: string;
			rel?: string;
			id: string;
			repo?: string;
			repoName?: string;
			name: string;
			kind: string;
			gist: string;
			title?: string;
	  }
	| { type: "url" | "file" | "unresolved"; target: string; rel?: string };

/**
 * A doc in another repo, named `<repo-quid>:<path>`, read without fetching:
 * helm shows what is on disk. Undefined for any other ref, and for one it
 * cannot read.
 */
export function helmRepoDoc(view: BridgeView, ref: string): KbDoc | undefined {
	const qualified = splitRepoRef(ref);
	if (!qualified || qualified.repo === view.rc.bridge) return undefined;
	const repo = view.docs.find((doc) => doc.id === qualified.repo && doc.kind === "repo");
	try {
		return repo && readRepoDoc(view.rc, repo, qualified.path, false);
	} catch {
		return undefined;
	}
}

/** A doc's text: off disk, or out of the managed cache for one read from there. */
export function helmDocText(view: BridgeView, doc: KbDoc): string {
	const home = doc.home;
	if (!home || home.checkout) return readFileSync(doc.path, "utf8");
	const repo = view.docs.find((candidate) => candidate.id === home.repoId)!;
	return readRepoFile(view.rc, repo, doc.relPath, false)?.text ?? "";
}

function docLink(link: LinkRef, target: KbDoc, repo?: string): HelmLink {
	return {
		type: "doc",
		target: link.target,
		rel: link.rel,
		id: target.id,
		...(repo ? { repo } : {}),
		name: target.name,
		kind: target.kind,
		gist: target.gist,
		title: target.h1,
	};
}

/**
 * A link from `from`, a doc in repo `fromRepo` whose kb is `local`, as helm
 * shows it. A bare ref names the nearest copy: `local`, then the bridge. A
 * `<repo-quid>:<path>` ref into a repo `from` may link is read from that repo;
 * one helm cannot read is unresolved, never an error.
 */
export function helmLink(
	view: BridgeView,
	from: KbDoc,
	fromRepo: string | undefined,
	local: Map<string, KbDoc>,
	link: LinkRef,
): HelmLink {
	const { rc } = view;
	const builtin = builtinDocPath(link.id);
	if (builtin) return docLink(link, readKbDoc(builtin, rc.bridgeDir));
	const inBridge = (id: string) => view.docs.find((doc) => doc.id === id);
	const own = fromRepo === rc.bridge ? undefined : fromRepo;
	if (link.repo && link.repo !== fromRepo) {
		const path = splitRepoRef(link.target)!.path;
		const bridgeDoc =
			link.repo === rc.bridge ? view.docs.find((doc) => doc.relPath === path) : undefined;
		if (bridgeDoc) return docLink(link, bridgeDoc);
		const elsewhere = mayLinkRepo(rc, from.scopes, fromRepo, link.repo)
			? helmRepoDoc(view, link.target)
			: undefined;
		if (elsewhere) return docLink(link, elsewhere, link.repo);
		return { type: "unresolved", target: link.target, rel: link.rel };
	}
	const near = local.get(link.id);
	if (near) return docLink(link, near, own);
	const bridgeDoc = own ? inBridge(link.id) : undefined;
	if (bridgeDoc) return docLink(link, bridgeDoc);
	return {
		type: URL_TARGET.test(link.target) ? "url" : "file",
		target: link.target,
		rel: link.rel,
	};
}
