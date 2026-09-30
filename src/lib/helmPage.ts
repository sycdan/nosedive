import { helmCreateScript } from "./helmCreateUi.js";
import { helmSyncScript } from "./helmSyncUi.js";
import { helmDiveScript } from "./helmDiveUi.js";
import { helmEditScript } from "./helmEdit.js";
import { helmStyle } from "./helmStyle.js";
import { helmTreeScript } from "./helmTree.js";

/** The whole helm UI: one page, no build step, talking to helm's JSON API. */
export const helmPage = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>helm</title>
<style>${helmStyle}</style>
</head>
<body>
<header><h1>helm</h1><span id="branch" class="branch"></span><span id="syncacts"></span><nav id="crumbs" aria-label="Breadcrumb"></nav><span class="gap"></span><button id="reposbtn" class="act unstage">Repos</button><select id="deckpick" aria-label="Deck"></select><span id="headacts"></span></header>
<div id="divebar" aria-label="Dive"></div>
<aside><ul class="tree" id="tree" aria-label="Bridge"></ul></aside>
<main><div id="error" hidden></div><div id="view"></div></main>
<script>
const token = new URLSearchParams(location.search).get("token");
const deckIds = new Set();
let bridge = { name: "" };
let selectedRow = null;
/** What is picked and selected: the deck, a feat under it, and the repo and kind the subtrees show. */
const ctx = { deck: null, feat: null, repo: null, kind: null };
const OUT_OF_REACH = "crud cannot write here now: jump a dive that scopes it to edit";

async function api(path) {
	const res = await fetch(path, { headers: { "x-helm-token": token } });
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || res.statusText);
	return body;
}

function el(tag, attrs, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs || {})) {
		if (value == null) continue;
		if (key === "class") node.className = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value);
	}
	for (const child of children.flat()) if (child != null) node.append(child);
	return node;
}

function showError(err) {
	const box = document.getElementById("error");
	box.textContent = err ? String(err.message || err) : "";
	box.hidden = !err;
}

/** A doc named by its own id has no name to show; its heading, else its gist, says what it is. */
function display(doc) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(doc.name) ? doc.title || doc.gist || doc.name : doc.name;
}

function contextQuery(deckId, withRepo) {
	const params = new URLSearchParams({ deck: deckId });
	if (ctx.feat && ctx.deck === deckId) params.set("feat", ctx.feat);
	if (withRepo && ctx.repo && ctx.deck === deckId) params.set("repo", ctx.repo);
	const dive = diveInContext();
	if (dive) params.set("dive", dive);
	return "/api/context?" + params;
}

${helmTreeScript}

// --- main pane --------------------------------------------------------------

function fact(dotClass, label, value) {
	return el("span", { class: "fact" }, el("span", { class: "dot " + dotClass }), label,
		value == null ? null : el("code", {}, value));
}

function repoCard(repo) {
	const h = repo.hydrated;
	const n = repo.nosedive;
	return el("article", { class: "card" + (repo.inCrudContext === false ? " out" : ""), title: repo.inCrudContext === false ? OUT_OF_REACH : null },
		el("div", { class: "name" }, el("span", { class: "icon" }, repo.icon || "▢"), repo.name,
			repo.isBridge ? el("span", { class: "tag" }, "bridge") : null),
		el("div", { class: "gist" }, repo.gist),
		el("div", { class: "facts" },
			h ? fact(h.atTrunk ? "ok" : "warn", (h.atTrunk ? "at " : "off ") + repo.trunk, h.commit.slice(0, 8))
				: fact("", "not hydrated"),
			n === "unknown" ? fact("", "nosedive ?") : n ? fact("ok", "nosedive", "L" + n.level) : fact("", "no nosedive")),
		cardActions(repo));
}

function crumbs(path) {
	const parts = [el("button", { title: "Nothing selected", onclick: reset }, bridge.name)];
	path.forEach((step, index) => parts.push(el("span", { class: "sep" }, "/"),
		el("button", { title: step.name, onclick: () => step.id === "#repos" ? showRepos() : select(path.slice(0, index + 1)) }, step.name)));
	document.getElementById("crumbs").replaceChildren(...parts);
}

function highlight(row) {
	if (selectedRow) selectedRow.classList.remove("selected");
	selectedRow = row || null;
	if (row) row.classList.add("selected");
}

function writeHash(path) {
	const params = new URLSearchParams();
	if (ctx.repo) params.set("repo", ctx.repo);
	if (ctx.kind) params.set("kind", ctx.kind.repoId + ":" + ctx.kind.id + ":" + ctx.kind.name);
	const tail = params.toString();
	history.replaceState(null, "", "#" + path.map((step) => step.repo ? step.repo + ":" + step.id : step.id).join("/") + (tail ? "?" + tail : ""));
}

function reset() {
	highlight(null);
	Object.assign(ctx, { feat: null, repo: null, kind: null });
	history.replaceState(null, "", location.pathname + location.search);
	// On a dive, home is the Repos view: where making things starts.
	if (dives.active) return showRepos();
	reposOpen = false;
	crumbs([]);
	document.getElementById("view").replaceChildren(
		...(dives.active ? [] : [divePicker()]),
		el("div", { class: "start" }, ...deckForm()));
}

function docBody(doc, withFrontmatter) {
	const body = el("div", { class: "doc" + (withFrontmatter ? "" : " deck-body") });
	body.innerHTML = doc.html;
	return withFrontmatter
		? [el("details", { class: "fm" }, el("summary", {}, "frontmatter"), el("pre", {}, doc.frontmatter)), body]
		: [body];
}

/** Selects the last doc on a path of steps from a deck down. */
async function select(path, row, message) {
	reposOpen = false;
	highlight(row);
	const last = path[path.length - 1];
	const feat = [...path].reverse().find(isFeatStep);
	const narrowed = ctx.feat !== (feat ? feat.id : null);
	ctx.feat = feat ? feat.id : null;
	if (narrowed) refreshRepos();
	writeHash(path);
	crumbs(path);
	const view = document.getElementById("view");
	try {
		const doc = await api("/api/doc?id=" + last.id + (last.repo ? "&repo=" + last.repo : ""));
		showError(null);
		stageOpened(doc);
		if (last.name !== label(doc)) { last.name = label(doc); crumbs(path); }
		if (deckIds.has(last.id)) {
			view.replaceChildren(...(dives.active ? [] : [divePicker()]), ...docBody(doc, false));
			return;
		}
		// Opened from a kind's list, a doc's meta is editable through a form from that kind's schema.
		const ref = last.kindRef;
		const kindDoc = ref ? await api("/api/doc?id=" + ref.id + "&repo=" + ref.repoId) : null;
		const form = kindDoc
			? metaForm(doc, ref.repoId, kindDoc.meta && kindDoc.meta.schema, ref.inCrudContext, (msg) => select(path, row, msg))
			: null;
		view.replaceChildren(...[message, featActions(doc, last), featLinker(doc, last), form].filter(Boolean), ...docBody(doc, true));
	} catch (err) { showError(err); }
}

/** Whether the main pane shows the Repos view, so a write can redraw its counts. */
let reposOpen = false;

function refreshRepos() {
	if (reposOpen) showRepos();
}

/**
 * The picked deck's repos, each card with the kinds its kb declares and how
 * many docs of each it holds; a kind opens its page. A repo whose kb cannot
 * be read -- not hydrated -- says so.
 */
async function showRepos() {
	reposOpen = true;
	highlight(null);
	const path = [deckStep(ctx.deck), { id: "#repos", name: "Repos" }];
	crumbs(path);
	const view = document.getElementById("view");
	try {
		const context = await api(contextQuery(ctx.deck, false));
		showError(null);
		if (!reposOpen) return;
		const unreadable = new Set(context.unreadable);
		view.replaceChildren(context.repos.length
			? el("div", { class: "repos" }, context.repos.map((repo) => {
				const kinds = context.kinds.filter((kind) => kind.repoId === repo.id);
				const list = kinds.length
					? el("ul", { class: "doclist" }, kinds.map((kind) => el("li", { class: kind.inCrudContext ? "" : "out", title: kind.inCrudContext ? null : OUT_OF_REACH },
						el("button", { class: "linkish", onclick: () => showKind(kind, [...path, { id: kind.id, name: kind.name, kind: "kind", repo: kind.repoId }]) }, kind.name),
						" ", el("span", { class: "count" }, String(kind.count)), " — ", kind.gist)))
					: el("p", { class: "empty" }, unreadable.has(repo.name) ? "Not hydrated, so its kb cannot be read." : "Declares no kinds.");
				return el("section", { class: "repo" }, repoCard(repo), list);
			}))
			: el("p", { class: "empty" }, "This deck scopes no repos."));
	} catch (err) { showError(err); }
}

/** A kind: the docs of it listed above the kind doc's own body. */
async function showKind(kind, path, row, message) {
	reposOpen = false;
	highlight(row);
	writeHash(path);
	crumbs(path);
	const view = document.getElementById("view");
	try {
		const [doc, docs] = await Promise.all([
			api("/api/doc?id=" + kind.id + "&repo=" + kind.repoId),
			api("/api/kind-docs?repo=" + kind.repoId + "&kind=" + encodeURIComponent(kind.name)),
		]);
		showError(null);
		const list = docs.length
			? el("ul", { class: "doclist" }, docs.map((d) => el("li", {},
				el("button", { class: "linkish", onclick: () => select([...path, { id: d.id, name: d.name, kind: kind.name, repo: kind.repoId, kindRef: kind }]) }, d.gist || d.name),
				" ", el("span", { class: "rel" }, d.name))))
			: el("p", { class: "empty" }, "No " + kind.name + " docs yet.");
		const rerender = (msg) => showKind(kind, path, row, msg);
		view.replaceChildren(...[message, list].filter(Boolean), schemaEditor(kind, doc, path, rerender), ...docBody(doc, false));
	} catch (err) { showError(err); }
}

${helmEditScript}
${helmDiveScript}
${helmCreateScript}
${helmSyncScript}
// Links inside a rendered doc: kb docs open here, everything else in a new tab.
document.getElementById("view").addEventListener("click", (event) => {
	const a = event.target.closest(".doc a[href]");
	if (!a) return;
	const quid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md/i.exec(a.getAttribute("href"));
	event.preventDefault();
	if (quid) select([...currentPath(), { id: quid[1].toLowerCase(), name: a.textContent }]);
	else if (/^[a-z][a-z0-9+.-]*:/i.test(a.getAttribute("href"))) window.open(a.href, "_blank", "noopener");
});

function currentPath() {
	const [path] = location.hash.slice(1).split("?");
	return path.split("/").filter(Boolean).map((part) => {
		const [repo, id] = part.includes(":") ? part.split(":") : [null, part];
		return { id, name: id.slice(0, 8), repo: repo || undefined };
	});
}

function restoreContext() {
	const [, query] = location.hash.slice(1).split("?");
	const params = new URLSearchParams(query || "");
	ctx.repo = params.get("repo");
	const kind = params.get("kind");
	if (kind) {
		const [repoId, id, name] = kind.split(":");
		ctx.kind = { repoId, id, name };
	}
}

// A restarted helm (a rebuild under node --watch, say) comes back on the same
// port with the same token but a new boot id; the page follows it.
let boot = null;
new EventSource("/api/events?token=" + token).addEventListener("boot", (event) => {
	if (boot && boot !== event.data) location.reload();
	boot = event.data;
});

document.getElementById("headacts").append(noteButton());
document.getElementById("reposbtn").addEventListener("click", showRepos);

Promise.all([loadDecks(), loadDives()]).then(() => {
	const path = currentPath();
	if (!path.length) return reset();
	// Names, kinds and link types are unknown after a reload: each step fills
	// in its own, and takes its rel -- what makes a feat a feat -- from the
	// step before it.
	Promise.all(path.map((step) => api("/api/doc?id=" + step.id + (step.repo ? "&repo=" + step.repo : ""))
		.then((doc) => { step.name = label(doc); step.kind = doc.kind; return doc; }, () => null)))
		.then((docs) => {
			path.forEach((step, i) => {
				const link = i > 0 && docs[i - 1] ? docs[i - 1].links.find((l) => l.id === step.id) : null;
				if (link) step.rel = link.rel;
			});
			restoreContext();
			select(path);
		});
}).catch(showError);
</script>
</body>
</html>
`;
