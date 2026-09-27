/** The whole helm UI: one page, no build step, talking to helm's JSON API. */
export const helmPage = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>helm</title>
<style>
:root {
	--bg: #f6f6f4; --panel: #ffffff; --line: #e3e3de; --text: #1c1c1a; --dim: #6b6b66;
	--accent: #2f6fdb; --hover: #ecece8; --ok: #1f8a4c; --warn: #b7791f; --off: #9a9a94;
	--radius: 8px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #131417; --panel: #1b1c20; --line: #2a2c31; --text: #e8e8e6; --dim: #8d8f96;
		--accent: #6ea0ff; --hover: #24262b; --ok: #4cc27f; --warn: #e0a84a; --off: #62646b;
		color-scheme: dark;
	}
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); display: grid;
	grid-template-rows: auto 1fr; grid-template-columns: minmax(260px, 340px) 1fr;
	font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { grid-column: 1 / -1; border-bottom: 1px solid var(--line); padding: 10px 16px;
	display: flex; gap: 12px; align-items: center; }
header h1 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin: 0; }
#crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; }
#crumbs .sep { color: var(--line); }
#crumbs button { border: 0; background: none; padding: 2px 4px; border-radius: 4px; cursor: pointer;
	color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 32ch; }
#crumbs button:hover { background: var(--hover); color: var(--text); }
#crumbs button:last-child { color: var(--text); font-weight: 600; }
aside { border-right: 1px solid var(--line); overflow: auto; padding: 8px 6px 24px; }
main { overflow: auto; padding: 16px 24px 48px; min-width: 0; }
button { font: inherit; color: inherit; }

/* tree */
.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.tree ul { padding-left: 14px; border-left: 1px solid var(--line); margin-left: 10px; }
.row { display: flex; align-items: center; gap: 2px; border-radius: 5px; min-height: 26px; }
.row:hover { background: var(--hover); }
.row.selected { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent); }
.twisty { width: 20px; height: 22px; border: 0; background: none; cursor: pointer; color: var(--dim);
	flex: none; padding: 0; font-size: 10px; }
.twisty:disabled { cursor: default; opacity: .35; }
.label { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; border: 0; background: none;
	padding: 3px 4px; cursor: pointer; text-align: left; white-space: nowrap; overflow: hidden; text-decoration: none; }
.label .text { overflow: hidden; text-overflow: ellipsis; }
.deck > .row .label { font-weight: 600; }
.kind { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); flex: none; }
.rel { font-size: 11px; color: var(--dim); flex: none; }
.url .text { color: var(--accent); }
.file .text, .cycle .text { color: var(--dim); }

/* main */
.empty { color: var(--dim); padding: 48px 0; text-align: center; }
.cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 12px 14px; display: grid; gap: 8px; }
.card .name { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.icon { width: 22px; text-align: center; font-size: 17px; }
.gist { color: var(--dim); font-size: 12px; overflow: hidden;
	display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.facts { display: flex; flex-wrap: wrap; gap: 6px; }
.fact { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 8px;
	border-radius: 4px; background: var(--bg); color: var(--dim); }
.fact code { font-family: var(--mono); color: var(--text); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--off); }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
.tag { font-size: 11px; color: var(--accent); font-weight: 500; }
details.fm { margin: 0 0 16px; }
details.fm summary { display: inline-block; cursor: pointer; color: var(--dim); font-size: 12px;
	padding: 2px 6px; border-radius: 4px; list-style: none; }
details.fm summary::before { content: "▸ "; }
details.fm[open] summary::before { content: "▾ "; }
details.fm summary:hover { background: var(--hover); color: var(--text); }
details.fm summary:focus { outline: none; }
details.fm summary:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
details.fm pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 10px 12px; overflow: auto; font: 12px/1.5 var(--mono); }
.doc { max-width: 80ch; }
.doc a { color: var(--accent); }
.doc pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 10px 12px; overflow: auto; }
.doc code { font-family: var(--mono); font-size: 12.5px; }
.doc table { border-collapse: collapse; } .doc th, .doc td { border: 1px solid var(--line); padding: 4px 8px; }
.start { max-width: 420px; margin: 48px auto; text-align: center; }
.start .empty { padding: 0 0 16px; }
form.make { display: flex; gap: 8px; }
form.make input { flex: 1; min-width: 0; font: inherit; padding: 7px 10px; border-radius: 6px;
	border: 1px solid var(--line); background: var(--panel); color: var(--text); }
form.make input:focus { outline: none; border-color: var(--accent); }
form.make button { font: inherit; padding: 7px 14px; border-radius: 6px; border: 0; cursor: pointer;
	background: var(--accent); color: #fff; }
.status { color: #d64545; font-size: 12px; min-height: 1em; }
.deck-body { margin-top: 24px; padding-top: 8px; border-top: 1px solid var(--line); }
.deck-body:empty { display: none; }
#error { color: #d64545; white-space: pre-wrap; font-family: var(--mono); margin: 0 0 12px; }
</style>
</head>
<body>
<header><h1>helm</h1><nav id="crumbs" aria-label="Breadcrumb"></nav></header>
<aside><ul class="tree" id="tree" aria-label="Decks"></ul></aside>
<main><div id="error" hidden></div><div id="view"></div></main>
<script>
const token = new URLSearchParams(location.search).get("token");
const deckIds = new Set();
let bridge = { name: "" };
let selectedRow = null;

async function api(path, payload) {
	const res = await fetch(path, payload === undefined
		? { headers: { "x-helm-token": token } }
		: { method: "POST", headers: { "x-helm-token": token, "content-type": "application/json" }, body: JSON.stringify(payload) });
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

// --- tree -------------------------------------------------------------------

/** One tree node; docs expand lazily into their links, never into an ancestor. */
function node(item, ancestors) {
	const isDoc = item.type === "doc";
	const cycle = isDoc && ancestors.some((a) => a.id === item.id);
	const li = el("li", { class: (item.isDeck ? "deck " : "") + (cycle ? "cycle" : item.type) });
	const children = el("ul", { hidden: "" });
	const twisty = el("button", { class: "twisty", "aria-label": "expand", disabled: isDoc && !cycle ? null : "" },
		isDoc && !cycle ? "▶" : "");
	let loaded = false;
	twisty.addEventListener("click", async () => {
		const open = children.hidden;
		children.hidden = !open;
		twisty.textContent = open ? "▼" : "▶";
		if (!open || loaded) return;
		loaded = true;
		try {
			const doc = await api("/api/doc?id=" + item.id);
			children.replaceChildren(...doc.links.map((link) => node(link, [...ancestors, { id: item.id, name: item.name }])));
			if (!doc.links.length) { twisty.disabled = true; twisty.textContent = ""; }
		} catch (err) { showError(err); }
	});
	const parts = [
		isDoc ? el("span", { class: "kind" }, item.kind) : null,
		el("span", { class: "text" }, isDoc ? item.name : item.target),
		item.rel ? el("span", { class: "rel" }, item.rel) : null,
		cycle ? el("span", { class: "rel" }, "↺") : null,
	];
	const label = item.type === "url"
		? el("a", { class: "label", href: item.target, target: "_blank", rel: "noopener noreferrer", title: item.target }, parts)
		: el("button", { class: "label", title: item.gist || item.target, disabled: isDoc ? null : "" }, parts);
	const row = el("div", { class: "row" }, twisty, label);
	if (isDoc) label.addEventListener("click", () => select([...ancestors, { id: item.id, name: item.name }], row));
	li.append(row, children);
	return li;
}

async function loadDecks() {
	const listing = await api("/api/decks");
	bridge = listing.bridge;
	const decks = listing.decks;
	for (const deck of decks) deckIds.add(deck.id);
	document.getElementById("tree").replaceChildren(...decks.map((deck) =>
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
	return el("article", { class: "card" },
		el("div", { class: "name" }, el("span", { class: "icon" }, repo.icon || "▢"), repo.name,
			repo.isBridge ? el("span", { class: "tag" }, "bridge") : null),
		el("div", { class: "gist" }, repo.gist),
		el("div", { class: "facts" },
			h ? fact(h.atTrunk ? "ok" : "warn", (h.atTrunk ? "at " : "off ") + repo.trunk, h.commit.slice(0, 8))
				: fact("", "not hydrated"),
			n === "unknown" ? fact("", "nosedive ?") : n ? fact("ok", "nosedive", "L" + n.level) : fact("", "no nosedive")));
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

function reset() {
	highlight(null);
	history.replaceState(null, "", location.pathname + location.search);
	crumbs([]);
	const input = el("input", { type: "text", placeholder: "New deck name", "aria-label": "New deck name", required: "" });
	const status = el("p", { class: "status" });
	const form = el("form", { class: "make" }, input, el("button", { type: "submit" }, "Make deck"));
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		status.textContent = "";
		form.inert = true;
		try {
			const made = await api("/api/decks", { name: input.value });
			await loadDecks();
			select([{ id: made.id, name: input.value }]);
		} catch (err) {
			status.textContent = String(err.message || err);
		} finally {
			form.inert = false;
		}
	});
	document.getElementById("view").replaceChildren(
		el("div", { class: "start" }, el("p", { class: "empty" }, "Pick a deck, or anything below one."), form, status));
	input.focus();
}

/** Selects the last doc on a path of { id, name } steps from a deck down. */
async function select(path, row) {
	highlight(row);
	const id = path[path.length - 1].id;
	history.replaceState(null, "", "#" + path.map((step) => step.id).join("/"));
	crumbs(path);
	const view = document.getElementById("view");
	try {
		const doc = await api("/api/doc?id=" + id);
		showError(null);
		if (path[path.length - 1].name !== doc.name) { path[path.length - 1].name = doc.name; crumbs(path); }
		if (deckIds.has(id)) {
			const repos = await api("/api/deck-repos?id=" + id);
			const body = el("div", { class: "doc deck-body" });
			body.innerHTML = doc.html;
			view.replaceChildren(repos.length
				? el("div", { class: "cards" }, repos.map(repoCard))
				: el("p", { class: "empty" }, "This deck scopes no repos."), body);
			return;
		}
		const body = el("div", { class: "doc" });
		body.innerHTML = doc.html;
		view.replaceChildren(
			el("details", { class: "fm" }, el("summary", {}, "frontmatter"), el("pre", {}, doc.frontmatter)), body);
	} catch (err) { showError(err); }
}

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
	return location.hash.slice(1).split("/").filter(Boolean).map((id) => ({ id, name: id.slice(0, 8) }));
}

// A restarted helm (a rebuild under node --watch, say) comes back on the same
// port with the same token but a new boot id; the page follows it.
let boot = null;
new EventSource("/api/events?token=" + token).addEventListener("boot", (event) => {
	if (boot && boot !== event.data) location.reload();
	boot = event.data;
});

loadDecks().then(() => {
	const path = currentPath();
	if (!path.length) return reset();
	// Names are unknown after a reload; each step fills its own in as it loads.
	Promise.all(path.map((step) => api("/api/doc?id=" + step.id).then((doc) => { step.name = doc.name; }, () => {})))
		.then(() => select(path));
}).catch(showError);
</script>
</body>
</html>
`;
