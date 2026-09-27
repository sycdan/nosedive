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
	--accent: #2f6fdb; --ok: #1f8a4c; --warn: #b7791f; --off: #9a9a94;
	--radius: 8px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #131417; --panel: #1b1c20; --line: #2a2c31; --text: #e8e8e6; --dim: #8d8f96;
		--accent: #6ea0ff; --ok: #4cc27f; --warn: #e0a84a; --off: #62646b;
		color-scheme: dark;
	}
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
	font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 1; background: var(--bg);
	border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; gap: 12px; align-items: center; }
header h1 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin: 0; }
#bar { display: flex; gap: 6px; overflow-x: auto; flex: 1; scrollbar-width: thin; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px;
	border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer;
	white-space: nowrap; font: inherit; }
.chip:hover { border-color: var(--dim); }
.chip[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.chip.bridge { font-weight: 600; }
main { padding: 16px; display: grid; gap: 10px;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 12px 14px; display: grid; gap: 8px; cursor: pointer; }
.card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.title { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.icon { width: 24px; text-align: center; font-size: 18px; }
.gist { color: var(--dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis;
	display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.facts { display: flex; flex-wrap: wrap; gap: 6px; }
.fact { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 8px;
	border-radius: 4px; background: var(--bg); color: var(--dim); }
.fact code { font-family: var(--mono); color: var(--text); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--off); }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
.tag { font-size: 11px; color: var(--accent); font-weight: 500; }
#error { color: #d64545; padding: 16px; white-space: pre-wrap; font-family: var(--mono); }
</style>
</head>
<body>
<header><h1>helm</h1><nav id="bar" aria-label="Repos"></nav></header>
<div id="error" hidden></div>
<main id="cards"></main>
<script>
const token = new URLSearchParams(location.search).get("token");
let board = { repos: [] };
let selected = null;

async function api(path, init) {
	const res = await fetch(path, { ...init, headers: { "x-helm-token": token, ...(init && init.headers) } });
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || res.statusText);
	return body;
}

function el(tag, attrs, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs || {})) {
		if (key === "class") node.className = value;
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value);
	}
	for (const child of children.flat()) if (child != null) node.append(child);
	return node;
}

const icon = (repo) => repo.icon || "▢";

function fact(dotClass, label, value) {
	return el("span", { class: "fact" }, el("span", { class: "dot " + dotClass }), label,
		value == null ? null : el("code", {}, value));
}

function facts(repo) {
	const h = repo.hydrated;
	const hydration = h
		? fact(h.atTrunk ? "ok" : "warn", h.atTrunk ? "at " + repo.trunk : "off " + repo.trunk, h.commit.slice(0, 8))
		: fact("", "not hydrated");
	const n = repo.nosedive;
	const install = n === "unknown" ? fact("", "nosedive ?")
		: n ? fact("ok", "nosedive", "L" + n.level) : fact("", "no nosedive");
	return el("div", { class: "facts" }, hydration, install);
}

function select(id) {
	selected = id;
	render();
}

function render() {
	const bar = document.getElementById("bar");
	bar.replaceChildren(...board.repos.map((repo) =>
		el("button", { class: "chip" + (repo.isBridge ? " bridge" : ""), "aria-pressed": String(repo.id === selected),
			title: repo.gist, onclick: () => select(repo.id) },
			el("span", {}, icon(repo)), repo.name)));
	const cards = document.getElementById("cards");
	cards.replaceChildren(...board.repos.map((repo) =>
		el("article", { class: "card" + (repo.id === selected ? " selected" : ""), onclick: () => select(repo.id) },
			el("div", { class: "title" }, el("span", { class: "icon" }, icon(repo)), repo.name,
				repo.isBridge ? el("span", { class: "tag" }, "bridge") : null),
			el("div", { class: "gist" }, repo.gist),
			facts(repo))));
}

async function load() {
	const error = document.getElementById("error");
	try {
		board = await api("/api/board");
		if (!selected && board.repos.length) selected = board.repos[0].id;
		error.hidden = true;
		render();
	} catch (err) {
		error.textContent = String(err.message || err);
		error.hidden = false;
	}
}

load();
</script>
</body>
</html>
`;
