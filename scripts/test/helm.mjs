import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { Script } from "node:vm";
import { join } from "node:path";
import { test } from "node:test";

import {
	assertOk,
	cli,
	createBridge,
	createTmp,
	gitCommit,
	implRepo,
	libUrl,
	root,
	run,
	runTool,
	write,
	writeImplRepoDoc,
} from "../test-helpers.mjs";

const tmp = createTmp("helm");
const minted = run(["mint", "14"], tmp);
assertOk(minted, "mint failed");
const [
	BACKLOG,
	BRIDGE_REPO,
	HYDRATED,
	INSTALLED,
	UNLISTED,
	FEAT,
	IDEAS,
	CHILD,
	CARD_KIND,
	NOTE_KIND,
	CARD_1,
	CARD_2,
	NOTE_1,
	DIVE,
] = minted.stdout.trim().split(/\r?\n/);
const { helmPicker } = await import(libUrl);

function fixture() {
	const bridge = createBridge(tmp, "bridge", { backlog: BACKLOG, bridge: BRIDGE_REPO });
	const hydrated = implRepo(tmp, "hydrated");
	const installed = implRepo(tmp, "installed");
	const unlisted = implRepo(tmp, "unlisted");

	write(join(hydrated.source, "kb", `${CARD_KIND}.md`), kindDoc(CARD_KIND, "card"));
	for (const id of [CARD_1, CARD_2])
		write(
			join(hydrated.source, "kb", `${id}.md`),
			`---\nkind: card\nid: ${id}\nname: ${id}\ngist: "A card"\n---\n`,
		);
	runTool("git", ["add", "."], hydrated.source);
	gitCommit(hydrated.source, "cards");
	runTool("git", ["push", "cloud", "main"], hydrated.source);

	// An installed repo is one whose trunk carries a nosedive config with a level.
	write(
		join(installed.source, ".nosedive", "config.yaml"),
		"compatibility-level: 1\nkb: ./notes\n",
	);
	runTool("git", ["add", "."], installed.source);
	gitCommit(installed.source, "install nosedive");
	runTool("git", ["push", "cloud", "main"], installed.source);

	writeImplRepoDoc(bridge, HYDRATED, hydrated);
	writeImplRepoDoc(bridge, INSTALLED, installed);
	writeImplRepoDoc(bridge, UNLISTED, unlisted);
	write(
		join(bridge, "kb", `${BRIDGE_REPO}.md`),
		`---\nkind: repo\nid: ${BRIDGE_REPO}\nname: bridge\ngist: "The bridge"\nmeta:\n  path: .\n  trunk: main\n  icon: "🛰"\n---\n`,
	);
	write(
		join(bridge, "kb", `${BACKLOG}.md`),
		[
			"---",
			"kind: memo",
			`id: ${BACKLOG}`,
			"name: backlog",
			'gist: "Backlog"',
			"scopes:",
			`  - ${BRIDGE_REPO}`,
			`  - ${HYDRATED}`,
			`  - ${INSTALLED}`,
			"links:",
			`  - kb/${FEAT}.md:`,
			"      rel: current.feat",
			`  - kb/${UNLISTED}.md:`,
			"      rel: linked.repo",
			"---",
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${FEAT}.md`),
		[
			"---",
			"kind: feat",
			`id: ${FEAT}`,
			"name: the-feat",
			'gist: "A feat"',
			"scopes:",
			`  - ${HYDRATED}`,
			"links:",
			"  - https://example.com/pr/1:",
			"      rel: pr",
			`  - kb/${BACKLOG}.md`,
			"  - kb/artifacts/missing.mjs",
			"---",
			"",
			"# The Feat",
			"",
			"## Why",
			"",
			"See [the docs](https://example.com/docs). <script>alert(1)</script>",
			"",
		].join("\n"),
	);
	write(
		join(bridge, "kb", `${CHILD}.md`),
		`---\nkind: feat\nid: ${CHILD}\nname: child.the-feat\ngist: "A child feat"\nlinks:\n  - kb/${FEAT}.md:\n      rel: parent\n---\n`,
	);
	write(
		join(bridge, "kb", `${NOTE_KIND}.md`),
		kindDoc(NOTE_KIND, "note", [
			"topic:",
			"  type: string",
			"price:",
			"  type: number",
			"  minimum: 0",
		]),
	);
	write(
		join(bridge, "kb", `${NOTE_1}.md`),
		`---\nkind: note\nid: ${NOTE_1}\nname: ${NOTE_1}\ngist: "A note"\n---\n`,
	);
	write(
		join(bridge, "kb", `${IDEAS}.md`),
		`---\nkind: memo\nid: ${IDEAS}\nname: ideas\ngist: "Ideas"\n---\n\n# Ideas\n`,
	);
	runTool("git", ["add", "."], bridge);
	gitCommit(bridge, "fixture");
	assertOk(run(["hydrate-repo.workspace", HYDRATED], bridge), "hydrate failed");
	// Leaves the managed cache behind, which is what the board reads trunk from.
	assertOk(run(["hydrate-repo.workspace", INSTALLED], bridge), "hydrate failed");
	assertOk(run(["dehydrate-repo.workspace", INSTALLED], bridge), "dehydrate failed");
	return bridge;
}

function kindDoc(id, name, properties = []) {
	return [
		"---",
		"kind: kind",
		`id: ${id}`,
		`name: ${name}`,
		`gist: "The ${name} kind"`,
		"meta:",
		"  schema:",
		"    type: object",
		"    additionalProperties: false",
		...(properties.length ? ["    properties:", ...properties.map((line) => `      ${line}`)] : []),
		"---",
		"",
		`# ${name}`,
		"",
	].join("\n");
}

/** Starts helm and resolves with its URL once it says where it is listening. */
function startHelm(cwd) {
	const child = spawn(process.execPath, [cli, "helm"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	const url = new Promise((resolveUrl, reject) => {
		child.stdout.on("data", (chunk) => {
			out += chunk;
			const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(out);
			if (match) resolveUrl(new URL(match[1]));
		});
		child.stderr.on("data", (chunk) => (err += chunk));
		child.on("exit", (code) => reject(new Error(`helm exited ${code}\n${out}\n${err}`)));
	});
	url.catch(() => {});
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	// Awaiting the exit frees the port before the next launch binds it.
	const stop = () => {
		child.kill();
		return exited;
	};
	return { url, stop };
}

test("helm serves the backlog as a link tree over a token-guarded API", async (t) => {
	const bridge = fixture();
	const { url, stop } = startHelm(bridge);
	t.after(stop);
	const base = await url;
	const token = base.searchParams.get("token");
	const get = async (path) => {
		const res = await fetch(new URL(path, base), { headers: { "x-helm-token": token } });
		assert.equal(res.status, 200, `${path}: ${res.status}`);
		return res.json();
	};

	const page = await fetch(base);
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, /<title>helm/i);
	// The page's script is a string in a TS file: nothing else would catch it not parsing.
	const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
	assert.ok(script, "page carries its script");
	assert.doesNotThrow(() => new Script(script), "page script parses");
	// A reload restores a kind page through showKind, and kindRef on a doc under a kind step.
	const restore =
		/Promise\.all\(\[loadRoots\(\), loadDives\(\)\]\)\.then[\s\S]*?\}\)\.catch\(showError\);/.exec(
			script,
		)?.[0];
	assert.ok(restore, "page carries its startup restore");
	assert.match(
		restore,
		/docs\[i\]\.kind === "kind" && path\[i\]\.repo/,
		"restore spots a kind step",
	);
	assert.match(
		restore,
		/if \(k === at\) return showKind\(kind, path\)/,
		"a kind step restores to showKind",
	);
	assert.match(
		restore,
		/path\[at\]\.kindRef = kind;\s*select\(path\)/,
		"a doc under a kind step gets its kindRef back",
	);
	assert.match(
		restore,
		/api\(contextQuery\(ctx\.root, false\)\)/,
		"the kind comes from the Kinds section's context",
	);
	// Repos and Kinds sit atop the main view; there is no Repos view any more.
	assert.doesNotMatch(
		html,
		/reposbtn|showRepos|#repos/,
		"the Repos button, view and crumb are gone",
	);
	assert.match(
		html,
		/<div id="top"><\/div><div id="view"><\/div>/,
		"the sections sit above the view",
	);
	assert.match(
		/function reset\(\) \{[\s\S]*?\n\}/.exec(script)?.[0] ?? "",
		/refreshSections\(\)/,
		"going home, the picker among the ways there, redraws the sections",
	);
	assert.match(
		/async function runVerb\(body\) \{[\s\S]*?\n\}/.exec(script)?.[0] ?? "",
		/refreshSections\(\)/,
		"a jump or land redraws the sections",
	);
	// Collapse state is per viewer, and a browser that keeps nothing still works.
	const openSource = [
		/function sectionOpen\(name, byDefault = true\) \{[\s\S]*?\n\}/.exec(script)?.[0],
		/function rememberOpen\(name, open\) \{[\s\S]*?\n\}/.exec(script)?.[0],
	];
	assert.ok(openSource.every(Boolean), "page carries the collapse helpers");
	const kept = new Map();
	const run = (localStorage) =>
		new Script(
			`const OPEN_KEY = "helm-open-"; ${openSource.join("\n")} ({ sectionOpen, rememberOpen })`,
		).runInNewContext({ localStorage });
	const remembering = run({
		getItem: (k) => kept.get(k) ?? null,
		setItem: (k, v) => kept.set(k, v),
	});
	assert.equal(remembering.sectionOpen("kinds"), true, "open until collapsed");
	remembering.rememberOpen("kinds", false);
	assert.equal(remembering.sectionOpen("kinds"), false, "a collapse is remembered");
	assert.equal(remembering.sectionOpen("repos"), true, "per section");
	assert.equal(
		remembering.sectionOpen("repos-rest", false),
		false,
		"the rest of the repos start folded",
	);
	remembering.rememberOpen("repos-rest", true);
	assert.equal(
		remembering.sectionOpen("repos-rest", false),
		true,
		"showing them all is remembered",
	);
	const throwing = run({
		getItem() {
			throw new Error("denied");
		},
		setItem() {
			throw new Error("denied");
		},
	});
	assert.equal(throwing.sectionOpen("repos"), true);
	assert.equal(throwing.sectionOpen("repos-rest", false), false);
	assert.doesNotThrow(() => throwing.rememberOpen("repos", false));
	// The home view offers the kb jump on the backlog only; other roots point at their feats.
	const rootForm = /function rootForm\(\) \{[\s\S]*?\n\}/.exec(script)?.[0];
	assert.ok(rootForm, "page carries rootForm");
	assert.ok(
		rootForm.includes("ctx.root && backlogRoot && ctx.root !== backlogRoot.id"),
		"rootForm guards on the backlog",
	);
	assert.ok(
		rootForm.includes("Pick a feat in the tree to plan a dive on it, or dive it free."),
		"other roots get the feat hint",
	);
	assert.ok(
		rootForm.indexOf("backlogRoot.id") < rootForm.indexOf("KB_FEAT"),
		"the guard comes before the kb fetch",
	);
	assert.doesNotMatch(script, /deck/i, "the page says root, never deck");
	// Pull and Push report in a corner notice and leave the view alone.
	const runSync = /async function runSync\(action, root\) \{[\s\S]*?\n\}/.exec(script)?.[0];
	assert.ok(runSync, "page carries runSync");
	assert.ok(!runSync.includes('"view"'), "runSync leaves the view alone");
	assert.match(runSync, /syncNotice\(/, "runSync creates the notice");
	assert.match(script, /function syncNotice\([\s\S]*?id: "syncnotice"/, "the notice is built");
	// The tree groups feat links under what their rel says before .feat, at every level.
	const featGroupsSource = /function featGroups\(items\) \{[\s\S]*?\n\}/.exec(script)?.[0];
	assert.ok(featGroupsSource, "page carries featGroups");
	const featGroups = new Script(`(${featGroupsSource})`).runInNewContext({});
	const grouped = featGroups([
		{ id: "a", rel: "future.feat" },
		{ id: "b", rel: "bug.note" },
		{ id: "c", rel: "current.feat" },
		{ id: "d", rel: "future.feat" },
		{ id: "e" },
		{ id: "f", rel: "https://example.com/x.feat.md" },
	]);
	assert.deepEqual(
		JSON.parse(JSON.stringify(grouped)),
		{
			groups: [
				{
					group: "future",
					items: [
						{ id: "a", rel: "future.feat" },
						{ id: "d", rel: "future.feat" },
					],
				},
				{ group: "current", items: [{ id: "c", rel: "current.feat" }] },
			],
			rest: [
				{ id: "b", rel: "bug.note" },
				{ id: "e" },
				{ id: "f", rel: "https://example.com/x.feat.md" },
			],
		},
		"feat links group by prefix in first-seen order; the rest keep their order",
	);
	assert.match(script, /function groupedRows\(items, render\)/, "page carries groupedRows");
	assert.match(
		script,
		/\.\.\.groupedRows\(listing\.feats, \(feat, hideRel\) => node\(feat, home, hideRel, Boolean\(listing\.pick\)\)\)/,
		"loadRoots groups the root's feats",
	);
	assert.match(
		script,
		/groupedRows\(doc\.links\.filter\(notADive\), \(link, hideRel\) => node\(link, path, hideRel\)\)/,
		"an expanded doc groups its links",
	);
	assert.match(
		script,
		/item\.rel && !hideRel \? el\("span", \{ class: "rel" \}, item\.rel\)/,
		"grouped rows leave the rel off",
	);
	assert.match(
		script,
		/const step = \{ id: item\.id, name: label\(item\), kind: item\.kind, rel: item\.rel, repo: item\.repo \}/,
		"the path step keeps the full rel",
	);

	assert.equal((await fetch(new URL("/", base))).status, 403, "page without token");
	const api = new URL("/api/picker", base);
	assert.equal((await fetch(api)).status, 403, "api without token");
	assert.equal(
		(await fetch(api, { headers: { "x-helm-token": "0".repeat(token.length) } })).status,
		403,
		"api with wrong token",
	);

	// At picker-level 0, the default, nothing is offered: the tree is the whole backlog.
	const {
		bridge: bridgeInfo,
		backlog: backlogRoot,
		feats,
		level,
		choices,
		pick,
		locked,
	} = await get("/api/picker");
	assert.deepEqual(
		{ id: bridgeInfo.id, name: bridgeInfo.name },
		{ id: BRIDGE_REPO, name: "bridge" },
	);
	assert.equal(bridgeInfo.branch.name, "main", "the header's branch is the bridge's checkout");
	assert.equal(bridgeInfo.branch.trunk, "main");
	assert.equal(backlogRoot.id, BACKLOG);
	assert.deepEqual(
		feats.map((feat) => [feat.id, feat.rel]),
		[[FEAT, "current.feat"]],
	);
	assert.equal(level, 0);
	assert.deepEqual(choices, []);
	assert.equal(pick, undefined);
	assert.equal(locked, false);

	const { repos } = await get(`/api/context?root=${BACKLOG}`);
	assert.deepEqual(
		repos.map((repo) => [repo.id, repo.inScope]),
		[
			[BRIDGE_REPO, true],
			[HYDRATED, true],
			[INSTALLED, true],
			[UNLISTED, false],
		],
		"every repo: the root's scoped ones first in scope order, then the rest",
	);
	const [bridgeCard, hydratedCard, installedCard] = repos;
	assert.equal(bridgeCard.isBridge, true);
	assert.equal(bridgeCard.icon, "🛰");
	assert.deepEqual(bridgeCard.nosedive, { level: 2 });
	assert.match(bridgeCard.hydrated.commit, /^[0-9a-f]{40}$/);
	assert.equal(hydratedCard.name, "hydrated");
	assert.equal(hydratedCard.icon, null);
	assert.equal(hydratedCard.hydrated.atTrunk, true);
	assert.equal(hydratedCard.nosedive, null, "no config file means not installed");
	assert.equal(installedCard.hydrated, null);
	assert.deepEqual(installedCard.nosedive, { level: 1 }, "read from trunk without hydrating");
	assert.deepEqual(
		(await get(`/api/context?root=${IDEAS}`)).repos.filter((repo) => repo.inScope),
		[],
	);

	const backlog = await get(`/api/doc?id=${BACKLOG}`);
	assert.deepEqual(
		backlog.links.map((link) => [link.type, link.id ?? link.target, link.rel ?? null]),
		[
			["doc", FEAT, "current.feat"],
			["doc", UNLISTED, "linked.repo"],
		],
	);
	assert.equal(backlog.links[0].name, "the-feat");
	assert.equal(backlog.links[0].kind, "feat");

	const feat = await get(`/api/doc?id=${FEAT}`);
	assert.equal(feat.kind, "feat");
	assert.deepEqual(
		feat.links.map((link) => [link.type, link.id ?? link.target]),
		[
			["url", "https://example.com/pr/1"],
			["doc", BACKLOG],
			["file", "kb/artifacts/missing.mjs"],
		],
	);
	assert.match(feat.html, /<h2[^>]*>Why<\/h2>/);
	assert.match(feat.html, /<a href="https:\/\/example.com\/docs"/);
	assert.doesNotMatch(feat.html, /<script>/, "raw html in a doc body is escaped");
	assert.match(feat.frontmatter, /^kind: feat$/m);

	const missing = await fetch(new URL(`/api/doc?id=${UNLISTED}0`, base), {
		headers: { "x-helm-token": token },
	});
	assert.equal(missing.status, 404);
});

test("helm's context: a root's repos, narrowed by a feat; kinds, narrowed by a repo, counted apart", async (t) => {
	const bridge = join(tmp, "bridge");
	const { url, stop } = startHelm(bridge);
	t.after(stop);
	const base = await url;
	const token = base.searchParams.get("token");
	const get = async (path) => {
		const res = await fetch(new URL(path, base), { headers: { "x-helm-token": token } });
		assert.equal(res.status, 200, `${path}: ${res.status}`);
		return res.json();
	};

	const root = await get(`/api/context?root=${BACKLOG}`);
	assert.deepEqual(
		root.repos.map((repo) => [repo.id, repo.inCrudContext]),
		[
			[BRIDGE_REPO, false],
			[HYDRATED, false],
			[INSTALLED, false],
			[UNLISTED, false],
		],
		"no dive: helm writes nowhere",
	);
	assert.deepEqual(
		root.kinds.map((kind) => [kind.id, kind.name, kind.repoId, kind.inCrudContext]),
		[
			[NOTE_KIND, "note", BRIDGE_REPO, false],
			[CARD_KIND, "card", HYDRATED, false],
		],
		"only the in-scope repos' kinds, and no counts: those are a request of their own",
	);
	assert.deepEqual(root.unreadable, ["installed"], "a repo not hydrated has no kb to read");
	const counts = await get(`/api/kind-counts?repos=${BRIDGE_REPO},${HYDRATED},${INSTALLED}`);
	assert.equal(counts[BRIDGE_REPO].note, 1);
	assert.equal(counts[HYDRATED].card, 2);
	assert.equal(counts[INSTALLED], undefined, "a kb that cannot be read is not counted");

	const feat = await get(`/api/context?root=${BACKLOG}&feat=${FEAT}`);
	assert.deepEqual(
		feat.repos.filter((repo) => repo.inScope).map((repo) => repo.id),
		[HYDRATED, BRIDGE_REPO, INSTALLED],
		"a feat the backlog reaches takes its own scopes, then the backlog's",
	);
	const child = await get(`/api/context?root=${BACKLOG}&feat=${CHILD}`);
	assert.deepEqual(
		child.repos.filter((repo) => repo.inScope).map((repo) => repo.id),
		[HYDRATED],
		"a feat with no scopes inherits its parent's, and no .feat link reaches it from the backlog",
	);

	const bridgeOnly = await get(`/api/context?root=${BACKLOG}&repo=${BRIDGE_REPO}`);
	assert.deepEqual(
		bridgeOnly.kinds.map((kind) => kind.name),
		["note"],
		"a selected repo narrows the kinds",
	);

	const cardKind = await get(`/api/doc?id=${CARD_KIND}&repo=${HYDRATED}`);
	assert.equal(cardKind.kind, "kind");
	assert.equal(cardKind.name, "card");
	assert.equal(cardKind.meta.schema.type, "object", "a doc carries its meta, for the page's forms");
	// A proposed schema is checked against every instance before it is saved.
	const check = async (schema) => {
		const res = await fetch(new URL("/api/kind-check", base), {
			method: "POST",
			headers: { "x-helm-token": token, "content-type": "application/json" },
			body: JSON.stringify({ repo: HYDRATED, kind: CARD_KIND, schema }),
		});
		assert.equal(res.status, 200);
		return res.json();
	};
	const open = {
		type: "object",
		additionalProperties: false,
		properties: { x: { type: "string" } },
	};
	assert.deepEqual((await check(open)).failures, [], "an optional field strands nothing");
	const strict = await check({ ...open, required: ["x"] });
	assert.deepEqual(strict.failures.map((f) => f.id).sort(), [CARD_1, CARD_2].sort());
	assert.match(strict.failures[0].errors[0], /required property 'x'/);

	const cards = await get(`/api/kind-docs?repo=${HYDRATED}&kind=card`);
	assert.deepEqual(cards.map((doc) => doc.id).sort(), [CARD_1, CARD_2].sort());

	// On a dive crud reaches only the scoped repos.
	write(
		join(bridge, "kb", `${DIVE}.md`),
		`---\nkind: dive\nid: ${DIVE}\nname: a-dive\ngist: "A dive"\nscopes:\n  - ${HYDRATED}\n---\n`,
	);
	const marker = join(bridge, "workspace", ".nosedive-ref");
	write(marker, `id: ${DIVE}\n`);
	t.after(() => rmSync(marker, { force: true }));
	const diving = await get(`/api/context?root=${BACKLOG}&dive=${DIVE}`);
	assert.deepEqual(
		diving.repos.map((repo) => [repo.id, repo.inScope, repo.inCrudContext]),
		[
			[HYDRATED, true, true],
			[BRIDGE_REPO, false, false],
			[INSTALLED, false, false],
			[UNLISTED, false, false],
		],
		"on a dive, its scopes are in scope",
	);
});

test("on a dive at level 0 helm shows the whole backlog; meta.root and meta.deck are ignored", (t) => {
	const bridge = join(tmp, "bridge");
	const diveDoc = join(bridge, "kb", `${DIVE}.md`);
	const before = readFileSync(diveDoc, "utf8");
	const marker = join(bridge, "workspace", ".nosedive-ref");
	write(marker, `id: ${DIVE}\n`);
	t.after(() => {
		rmSync(marker, { force: true });
		write(diveDoc, before);
	});
	const dive = (meta) =>
		write(
			diveDoc,
			`---\nkind: dive\nid: ${DIVE}\nname: a-dive\ngist: "A dive"\nmeta:\n${meta}---\n`,
		);
	dive(`  root: ${IDEAS}\n  deck: ${IDEAS}\n`);
	const picker = helmPicker(bridge);
	assert.equal(picker.locked, true);
	assert.equal(picker.pick, undefined, "nothing picked: the whole backlog");
	assert.equal(picker.backlog.id, BACKLOG);
	assert.deepEqual(
		picker.feats.map((feat) => feat.id),
		[FEAT],
	);
});

test("helm writes only by running crud, and only on an active dive; a note needs none", async (t) => {
	const bridge = join(tmp, "bridge");
	const { url, stop } = startHelm(bridge);
	t.after(stop);
	const base = await url;
	const token = base.searchParams.get("token");
	const post = async (path, body) => {
		const res = await fetch(new URL(path, base), {
			method: "POST",
			headers: { "x-helm-token": token, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const text = await res.text();
		return {
			status: res.status,
			text,
			body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {},
		};
	};
	const count = (cwd) => Number(runTool("git", ["rev-list", "--count", "HEAD"], cwd).stdout.trim());
	const worktree = join(bridge, "workspace", "hydrated");
	const subject = () => runTool("git", ["log", "-1", "--format=%s"], worktree).stdout.trim();

	const before = count(bridge);
	for (const [path, body] of [
		["/api/crud/mint", { repo: BRIDGE_REPO, kind: "note", gist: "Buy sleeves" }],
		["/api/crud/meta", { id: NOTE_1, patch: { topic: "x" } }],
		["/api/crud/links", { id: NOTE_1, patch: { [NOTE_1]: { rel: "idea.feat" } } }],
	]) {
		const refused = await post(path, body);
		assert.equal(refused.status, 409, path);
		assert.match(refused.body.error, /only on an active dive/);
	}
	assert.equal(count(bridge), before, "nothing was written with no dive");

	const noted = await post("/api/run", {
		verb: "note",
		text: "todo: buy sleeves\n\nThe matte ones.",
		scopes: [BRIDGE_REPO],
	});
	assert.equal(noted.status, 200, noted.text);
	assert.match(noted.text, /\[exit 0\]\s*$/);
	const notePath = /^Noted (\S+)$/m.exec(noted.text)?.[1];
	assert.ok(notePath, noted.text);
	const note = readFileSync(join(bridge, notePath), "utf8");
	assert.match(note, /^kind: memo$/m, "a leading <prefix>: leaves the note a memo");
	assert.match(note, /^gist: "buy sleeves"$/m, "the prefix leaves the gist");
	assert.match(note, /The matte ones\./, "lines after the first are its body");
	assert.match(
		note,
		new RegExp(`^scopes:\\n {2}- ${BRIDGE_REPO}`, "m"),
		"scoped to the repos picked",
	);
	const repos = await fetch(new URL("/api/repos", base), { headers: { "x-helm-token": token } });
	assert.ok(
		(await repos.json()).some((repo) => repo.id === BRIDGE_REPO),
		"the picker lists repos",
	);

	// On a dive that scopes the hydrated repo, helm writes there and nowhere else.
	write(
		join(bridge, "kb", `${DIVE}.md`),
		`---\nkind: dive\nid: ${DIVE}\nname: a-dive\ngist: "A dive"\nscopes:\n  - ${HYDRATED}\n---\n`,
	);
	const marker = join(bridge, "workspace", ".nosedive-ref");
	write(marker, `id: ${DIVE}\n`);
	t.after(() => rmSync(marker, { force: true }));

	const schema = await post("/api/crud/meta", {
		id: CARD_KIND,
		repo: HYDRATED,
		replace: true,
		patch: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { condition: { enum: ["mint", "played"] } },
			},
		},
	});
	assert.equal(schema.status, 200, schema.text);
	assert.equal(
		subject(),
		`crud(${CARD_KIND}): updated kind card`,
		"crud committed in the scoped repo",
	);

	const minted = await post("/api/crud/mint", {
		repo: HYDRATED,
		kind: "card",
		gist: "Llanowar Elves",
	});
	assert.equal(minted.status, 200, minted.text);
	const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(minted.body.stdout)?.[1];
	assert.equal(subject(), `crud(${id}): created card ${id}`);

	const edited = await post("/api/crud/meta", { id, repo: HYDRATED, patch: { condition: "mint" } });
	assert.equal(edited.status, 200, edited.text);
	assert.match(readFileSync(join(worktree, "kb", `${id}.md`), "utf8"), /^ {2}condition: mint$/m);

	const refused = await post("/api/crud/meta", {
		id,
		repo: HYDRATED,
		patch: { condition: "bent" },
	});
	assert.equal(refused.status, 400);
	assert.match(refused.body.error, /the card meta would not validate/, "crud's refusal, verbatim");
	assert.match(refused.body.error, /\/condition/);

	const outOfReach = await post("/api/crud/mint", {
		repo: BRIDGE_REPO,
		kind: "note",
		gist: "Sort bulk",
	});
	assert.equal(outOfReach.status, 409, "the bridge is not scoped, so refused before crud runs");
	assert.match(outOfReach.body.error, /jump a dive that scopes it/);
	assert.equal(count(bridge), before + 1, "only the note reached the bridge");

	const gone = await post("/api/crud/deck", { name: "Magic Cards", gist: "Cards" });
	assert.equal(gone.status, 404, "there is no deck to create");
	assert.equal(count(bridge), before + 1);
});

test("helm refuses a request whose Host is not the address it bound", async (t) => {
	const bridge = join(tmp, "bridge");
	const { url, stop } = startHelm(bridge);
	t.after(stop);
	const base = await url;
	const { request } = await import("node:http");
	const status = await new Promise((resolveStatus, reject) => {
		const req = request(
			{
				host: base.hostname,
				port: base.port,
				path: `/api/picker`,
				headers: { host: "evil.example", "x-helm-token": base.searchParams.get("token") },
			},
			(res) => resolveStatus(res.statusCode),
		);
		req.on("error", reject);
		req.end();
	});
	assert.equal(status, 403);
});

/** Reads server-sent events off a helm stream, one `{ event, data }` at a time. */
function events(res) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return {
		async next() {
			while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
			const end = buffer.indexOf("\n\n");
			const block = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			return {
				event: /^event: (.*)$/m.exec(block)?.[1],
				data: /^data: (.*)$/m.exec(block)?.[1],
			};
		},
		cancel: () => reader.cancel(),
	};
}

test("a restarted helm keeps its URL and tells open pages it rebooted", async (t) => {
	const bridge = join(tmp, "bridge");
	const first = startHelm(bridge);
	t.after(first.stop);
	const base = await first.url;
	const token = base.searchParams.get("token");
	const port = Number(base.port);
	assert.ok(port >= 20000 && port < 30000, `port ${port} is derived into 20000-29999`);

	assert.equal(
		(await fetch(new URL("/api/events?token=0", base))).status,
		403,
		"the event stream is token-guarded",
	);
	const bootOf = async (url) => {
		const res = await fetch(new URL(`/api/events?token=${token}`, url));
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type"), /text\/event-stream/);
		const stream = events(res);
		const boot = await stream.next();
		await stream.cancel();
		assert.equal(boot.event, "boot");
		return boot.data;
	};
	const firstBoot = await bootOf(base);
	await first.stop();

	// An open tab survives a restart only if the server comes back where it was
	// and still accepts the token the tab holds.
	const second = startHelm(bridge);
	t.after(second.stop);
	const again = await second.url;
	assert.equal(again.href, base.href);
	assert.notEqual(await bootOf(again), firstBoot);
});

test("a second helm for the same bridge names the running one instead of starting", async (t) => {
	const bridge = join(tmp, "bridge");
	const first = startHelm(bridge);
	t.after(first.stop);
	const base = await first.url;

	const second = spawnSync(process.execPath, [cli, "helm"], {
		cwd: bridge,
		encoding: "utf8",
		timeout: 15000,
	});
	assert.equal(second.status, 1, second.stdout);
	assert.ok(
		second.stderr.includes(`helm is already running for this bridge: ${base.href}`),
		second.stderr,
	);
});
