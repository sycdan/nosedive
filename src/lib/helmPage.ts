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
.crumb { color: var(--dim); font-size: 12px; margin-bottom: 4px; }
h2.title { margin: 0 0 4px; font-size: 20px; }
.lede { color: var(--dim); margin: 0 0 16px; }
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
details.fm summary { cursor: pointer; color: var(--dim); font-size: 12px; }
details.fm pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 10px 12px; overflow: auto; font: 12px/1.5 var(--mono); }
.doc { max-width: 80ch; }
.doc a { color: var(--accent); }
.doc pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 10px 12px; overflow: auto; }
.doc code { font-family: var(--mono); font-size: 12.5px; }
.doc table { border-collapse: collapse; } .doc th, .doc td { border: 1px solid var(--line); padding: 4px 8px; }
#error { color: #d64545; white-space: pre-wrap; font-family: var(--mono); margin: 0 0 12px; }
</style>
</head>
<body>
<header><h1>helm</h1></header>
<aside><ul class="tree" id="tree" aria-label="Decks"></ul></aside>
<main><div id="error" hidden></div><div id="view"></div></main>
<script>
const token = new URLSearchParams(location.search).get("token");
const deckIds = new Set();
let selectedRow = null;

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

// --- tree -------------------------------------------------------------------

/** One tree node; docs expand lazily into their links, never into an ancestor. */
function node(item, ancestors) {
	const isDoc = item.type === "doc";
	const cycle = isDoc && ancestors.includes(item.id);
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
			children.replaceChildren(...doc.links.map((link) => node(link, [...ancestors, item.id])));
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
	if (isDoc) label.addEventListener("click", () => select(item.id, row));
	li.append(row, children);
	return li;
}

async function loadDecks() {
	const decks = await api("/api/decks");
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

function heading(doc) {
	return [el("div", { class: "crumb" }, doc.kind), el("h2", { class: "title" }, doc.name), el("p", { class: "lede" }, doc.gist)];
}

async function select(id, row) {
	if (selectedRow) selectedRow.classList.remove("selected");
	selectedRow = row || null;
	if (row) row.classList.add("selected");
	history.replaceState(null, "", "#" + id);
	const view = document.getElementById("view");
	try {
		const doc = await api("/api/doc?id=" + id);
		showError(null);
		if (deckIds.has(id)) {
			const repos = await api("/api/deck-repos?id=" + id);
			view.replaceChildren(...heading(doc), repos.length
				? el("div", { class: "cards" }, repos.map(repoCard))
				: el("p", { class: "empty" }, "This deck scopes no repos."));
			return;
		}
		const body = el("div", { class: "doc" });
		body.innerHTML = doc.html;
		view.replaceChildren(...heading(doc),
			el("details", { class: "fm" }, el("summary", {}, "frontmatter"), el("pre", {}, doc.frontmatter)), body);
	} catch (err) { showError(err); }
}

// Links inside a rendered doc: kb docs open here, everything else in a new tab.
document.getElementById("view").addEventListener("click", (event) => {
	const a = event.target.closest(".doc a[href]");
	if (!a) return;
	const quid = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md/i.exec(a.getAttribute("href"));
	event.preventDefault();
	if (quid) select(quid[1].toLowerCase());
	else if (/^[a-z][a-z0-9+.-]*:/i.test(a.getAttribute("href"))) window.open(a.href, "_blank", "noopener");
});

function empty() {
	document.getElementById("view").replaceChildren(el("p", { class: "empty" }, "Pick a deck, or anything below one."));
}

loadDecks().then(() => {
	const id = location.hash.slice(1);
	if (id) select(id); else empty();
}).catch(showError);
</script>
</body>
</html>
`;
