import { helmDiveScript } from "./helmDiveUi.js";
import { helmEditScript } from "./helmEdit.js";
import { helmStyle } from "./helmStyle.js";

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
<header><h1>helm</h1><nav id="crumbs" aria-label="Breadcrumb"></nav></header>
<div id="divebar" aria-label="Dive"></div>
<aside><ul class="tree" id="tree" aria-label="Decks"></ul></aside>
<main><div id="error" hidden></div><div id="view"></div></main>
<script>
const token = new URLSearchParams(location.search).get("token");
const deckIds = new Set();
let bridge = { name: "" };
let selectedRow = null;
/** What is selected, and so what the Repos and Kinds subtrees show. */
const ctx = { deck: null, feat: null, repo: null, kind: null };
const groups = [];
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

/** A doc crud named by its id has no name yet; its gist says what it is. */
function display(doc) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(doc.name) && doc.gist ? doc.gist : doc.name;
}

function contextQuery(deckId, withRepo) {
	const params = new URLSearchParams({ deck: deckId });
	if (ctx.feat && ctx.deck === deckId) params.set("feat", ctx.feat);
	if (withRepo && ctx.repo && ctx.deck === deckId) params.set("repo", ctx.repo);
	const dive = diveInContext();
	if (dive) params.set("dive", dive);
	return "/api/context?" + params;
}

// --- tree -------------------------------------------------------------------

/** A row: a twisty that expands load() into children lazily, and a label. */
function branch(cls, parts, title, load, onPick) {
	const li = el("li", { class: cls });
	const children = el("ul", { hidden: "" });
	const twisty = el("button", { class: "twisty", "aria-label": "expand", disabled: load ? null : "" }, load ? "▶" : "");
	const label = el("button", { class: "label", title }, parts);
	const row = el("div", { class: "row" }, twisty, label);
	let loaded = false;
	const fill = async () => {
		try {
			const items = await load();
			children.replaceChildren(...items);
			if (!items.length) { twisty.disabled = true; twisty.textContent = ""; }
		} catch (err) { showError(err); }
	};
	twisty.addEventListener("click", () => {
		const open = children.hidden;
		children.hidden = !open;
		twisty.textContent = open ? "▼" : "▶";
		if (open && !loaded) { loaded = true; fill(); }
	});
	if (onPick) label.addEventListener("click", () => onPick(row));
	li.append(row, children);
	return { li, row, refill: () => { if (loaded) fill(); } };
}

/** One doc in the tree; it expands into its links, never into an ancestor. */
function node(item, ancestors) {
	if (item.type !== "doc") {
		const parts = [el("span", { class: "text" }, item.target), item.rel ? el("span", { class: "rel" }, item.rel) : null];
		const li = el("li", { class: item.type });
		const label = item.type === "url"
			? el("a", { class: "label", href: item.target, target: "_blank", rel: "noopener noreferrer", title: item.target }, parts)
			: el("button", { class: "label", title: item.target, disabled: "" }, parts);
		li.append(el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), label));
		return li;
	}
	const cycle = ancestors.some((a) => a.id === item.id);
	const step = { id: item.id, name: display(item), kind: item.kind };
	const path = [...ancestors, step];
	const parts = [
		el("span", { class: "kind" }, item.kind),
		el("span", { class: "text" }, display(item)),
		item.rel ? el("span", { class: "rel" }, item.rel) : null,
		cycle ? el("span", { class: "rel" }, "↺") : null,
	];
	const load = cycle ? null : async () => {
		const doc = await api("/api/doc?id=" + item.id);
		const links = doc.links.map((link) => node(link, path));
		return item.isDeck ? [group("repos", item.id, path), group("kinds", item.id, path), ...links] : links;
	};
	const b = branch((item.isDeck ? "deck " : "") + (cycle ? "cycle" : "doc"), parts, item.gist, load,
		(row) => select(path, row));
	return b.li;
}

/** A deck's Repos or Kinds subtree, refilled whenever the context changes. */
function group(type, deckId, deckPath) {
	const title = type === "repos" ? "Repos" : "Kinds";
	const load = async () => {
		const context = await api(contextQuery(deckId, type === "kinds"));
		if (type === "repos") return context.repos.map((repo) => repoItem(repo, deckId, deckPath));
		const kinds = context.kinds.map((kind) => kindItem(kind, deckId, deckPath));
		const blind = context.unreadable.map((name) =>
			el("li", { class: "file" }, el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }),
				el("button", { class: "label", disabled: "", title: "not hydrated, so its kb cannot be read" },
					el("span", { class: "text" }, name + ": kb not readable")))));
		return [...kinds, ...blind];
	};
	const b = branch("group", [el("span", { class: "text" }, title)], null, load,
		(row) => showGroup(type, deckId, [...deckPath.slice(0, 1), { id: "#" + type, name: title }], row));
	groups.push(b);
	return b.li;
}

function repoItem(repo, deckId, deckPath) {
	const picked = ctx.repo === repo.id && ctx.deck === deckId;
	const li = el("li", { class: "repo" + (repo.inCrudContext ? "" : " out") + (picked ? " picked" : "") });
	const label = el("button", { class: "label", title: repo.inCrudContext ? repo.gist : OUT_OF_REACH },
		el("span", { class: "icon" }, repo.icon || "▢"), el("span", { class: "text" }, repo.name));
	const row = el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), label);
	label.addEventListener("click", () => {
		ctx.deck = deckId;
		ctx.repo = picked ? null : repo.id;
		ctx.kind = null;
		refreshGroups();
		if (ctx.repo) select([deckPath[0], { id: repo.id, name: repo.name, kind: "repo" }], row);
		else writeHash(currentPath());
	});
	li.append(row);
	return li;
}

function kindItem(kind, deckId, deckPath) {
	const picked = ctx.kind && ctx.kind.id === kind.id && ctx.kind.repoId === kind.repoId;
	const li = el("li", { class: "kindnode" + (kind.inCrudContext ? "" : " out") + (picked ? " picked" : "") });
	const label = el("button", { class: "label", title: kind.inCrudContext ? kind.gist : OUT_OF_REACH },
		el("span", { class: "text" }, kind.name), el("span", { class: "count" }, String(kind.count)),
		el("span", { class: "rel" }, kind.repoName));
	const row = el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), label);
	label.addEventListener("click", () => {
		ctx.deck = deckId;
		ctx.kind = picked ? null : { id: kind.id, repoId: kind.repoId, name: kind.name };
		refreshGroups();
		if (ctx.kind) showKind(kind, [deckPath[0], { id: kind.id, name: kind.name, kind: "kind", repo: kind.repoId }], row);
		else writeHash(currentPath());
	});
	li.append(row);
	return li;
}

function refreshGroups() {
	for (const g of groups) if (g.li.isConnected) g.refill();
}

async function loadDecks() {
	const listing = await api("/api/decks");
	bridge = listing.bridge;
	for (const deck of listing.decks) deckIds.add(deck.id);
	groups.length = 0;
	document.getElementById("tree").replaceChildren(...listing.decks.map((deck) =>
		node({ type: "doc", isDeck: true, ...deck }, [])));
}

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
		el("button", { title: step.name, onclick: () => select(path.slice(0, index + 1)) }, step.name)));
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
	Object.assign(ctx, { deck: null, feat: null, repo: null, kind: null });
	refreshGroups();
	history.replaceState(null, "", location.pathname + location.search);
	crumbs([]);
	document.getElementById("view").replaceChildren(
		...(dives.active ? [] : [divePicker()]),
		el("div", { class: "start" }, el("p", { class: "empty" }, "Or pick a deck, or anything below one."), ...deckForm()));
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
	highlight(row);
	const last = path[path.length - 1];
	const deck = deckIds.has(path[0].id) ? path[0].id : null;
	const feat = [...path].reverse().find((step) => step.kind === "feat");
	const narrowed = ctx.deck !== deck || ctx.feat !== (feat ? feat.id : null);
	if (ctx.deck !== deck) Object.assign(ctx, { repo: null, kind: null });
	ctx.deck = deck;
	ctx.feat = feat ? feat.id : null;
	if (narrowed) refreshGroups();
	writeHash(path);
	crumbs(path);
	const view = document.getElementById("view");
	try {
		const doc = await api("/api/doc?id=" + last.id + (last.repo ? "&repo=" + last.repo : ""));
		showError(null);
		if (last.name !== display(doc)) { last.name = display(doc); crumbs(path); }
		if (deckIds.has(last.id)) {
			const context = await api(contextQuery(last.id, false));
			view.replaceChildren(context.repos.length
				? el("div", { class: "cards" }, context.repos.map(repoCard))
				: el("p", { class: "empty" }, "This deck scopes no repos."), ...docBody(doc, false));
			return;
		}
		// Opened from a kind's list, a doc's meta is editable through a form from that kind's schema.
		const ref = last.kindRef;
		const kindDoc = ref ? await api("/api/doc?id=" + ref.id + "&repo=" + ref.repoId) : null;
		const form = kindDoc
			? metaForm(doc, ref.repoId, kindDoc.meta && kindDoc.meta.schema, ref.inCrudContext, (msg) => select(path, row, msg))
			: null;
		view.replaceChildren(...[message, form].filter(Boolean), ...docBody(doc, true));
	} catch (err) { showError(err); }
}

async function showGroup(type, deckId, path, row) {
	highlight(row);
	ctx.deck = deckId;
	crumbs(path);
	const view = document.getElementById("view");
	try {
		const context = await api(contextQuery(deckId, type === "kinds"));
		showError(null);
		if (type === "repos") {
			view.replaceChildren(context.repos.length
				? el("div", { class: "cards" }, context.repos.map(repoCard))
				: el("p", { class: "empty" }, "No repos in view."));
			return;
		}
		view.replaceChildren(context.kinds.length
			? el("ul", { class: "doclist" }, context.kinds.map((kind) =>
				el("li", { class: kind.inCrudContext ? "" : "out", title: kind.inCrudContext ? null : OUT_OF_REACH },
					el("strong", {}, kind.name), " ", el("span", { class: "count" }, String(kind.count)), " ",
					el("span", { class: "rel" }, kind.repoName), " — ", kind.gist)))
			: el("p", { class: "empty" }, "No kinds in view."));
	} catch (err) { showError(err); }
}

/** A kind: the docs of it listed above the kind doc's own body. */
async function showKind(kind, path, row, message) {
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
		const form = mintForm(kind, rerender);
		view.replaceChildren(...[form, message, list].filter(Boolean), schemaEditor(kind, doc, path, rerender), ...docBody(doc, false));
	} catch (err) { showError(err); }
}

${helmEditScript}
${helmDiveScript}
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

Promise.all([loadDecks(), loadDives()]).then(() => {
	const path = currentPath();
	if (!path.length) return reset();
	// Names and kinds are unknown after a reload; each step fills its own in.
	Promise.all(path.map((step) => api("/api/doc?id=" + step.id + (step.repo ? "&repo=" + step.repo : ""))
		.then((doc) => { step.name = display(doc); step.kind = doc.kind; }, () => {})))
		.then(() => {
			restoreContext();
			ctx.deck = deckIds.has(path[0].id) ? path[0].id : null;
			select(path);
		});
}).catch(showError);
</script>
</body>
</html>
`;
