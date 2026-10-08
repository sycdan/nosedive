import { helmCreateScript } from "./helmCreateUi.js";
import { helmSyncScript } from "./helmSyncUi.js";
import { helmBranchesScript } from "./helmBranchesUi.js";
import { helmDiveScript } from "./helmDiveUi.js";
import { helmInternalsScript } from "./helmInternalsUi.js";
import { helmEditScript } from "./helmEdit.js";
import { helmPickerScript } from "./helmPickerUi.js";
import { helmSectionsScript } from "./helmSectionsUi.js";
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
<header><h1><button id="helmbtn" title="Helm internals">helm</button></h1><button id="branch" class="branch" type="button"></button><nav id="crumbs" aria-label="Breadcrumb"></nav><span class="gap"></span><span id="deckpick" class="deck"></span><span id="headacts"></span></header>
<div id="divebar" aria-label="Dive"></div>
<aside><ul class="tree" id="tree" aria-label="Repos in scope"></ul></aside>
<main><div id="error" hidden></div><div id="view"></div></main>
<script>
const token = new URLSearchParams(location.search).get("token");
const rootIds = new Set();
let bridge = { name: "" };
let selectedRow = null;
/** What is picked and selected: the deck (by its ref), and the repo and kind a reload restores. */
const ctx = { root: null, repo: null, kind: null };
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

function contextQuery(rootId, withRepo) {
	const params = new URLSearchParams({ root: rootId });
	if (withRepo && ctx.repo && ctx.root === rootId) params.set("repo", ctx.repo);
	const dive = diveInContext();
	if (dive) params.set("dive", dive);
	return "/api/context?" + params;
}

${helmTreeScript}
${helmPickerScript}

// --- main pane --------------------------------------------------------------

function fact(dotClass, label, value) {
	return el("span", { class: "fact" }, el("span", { class: "dot " + dotClass }), label,
		value == null ? null : el("code", {}, value));
}

function repoCard(repo) {
	return el("article", { class: "card" + (repo.inScope ? " inscope" : "") + (repo.inCrudContext === false ? " out" : ""), title: repo.inCrudContext === false ? OUT_OF_REACH : null },
		el("div", { class: "name" }, el("span", { class: "icon" }, repo.icon || "▢"), repo.name,
			repo.isBridge ? el("span", { class: "tag" }, "bridge") : null,
			repo.inScope ? el("span", { class: "tag" }, "in scope") : null),
		el("div", { class: "gist" }, repo.gist),
		el("div", { class: "facts repo-status" }, "checking…"),
		el("div", { class: "repo-actions" }), el("div", { class: "scope-actions" }));
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
	Object.assign(ctx, { repo: null, kind: null });
	history.replaceState(null, "", location.pathname + location.search);
	refreshSections();
	crumbs([]);
	document.getElementById("view").replaceChildren(
		...(dives.active ? [] : [divePicker()]),
		el("div", { class: "start" }, ...rootForm()));
}

function docBody(doc, withFrontmatter) {
	const body = el("div", { class: "doc" + (withFrontmatter ? "" : " root-body") });
	body.innerHTML = doc.html;
	return withFrontmatter
		? [el("details", { class: "fm" }, el("summary", {}, "frontmatter"), el("pre", {}, doc.frontmatter)), body]
		: [body];
}

/** Selects the last doc on a path of steps from a root down. */
async function select(path, row, message) {
	highlight(row);
	const last = path[path.length - 1];
	writeHash(path);
	crumbs(path);
	const view = document.getElementById("view");
	try {
		const doc = await api("/api/doc?id=" + last.id + (last.repo ? "&repo=" + last.repo : ""));
		showError(null);
		stageOpened(doc);
		if (last.name !== label(doc)) { last.name = label(doc); crumbs(path); }
		if (rootIds.has(last.id)) {
			view.replaceChildren(dives.active ? planForm(doc) : divePicker(), ...docBody(doc, false));
			return;
		}
		// Opened from a kind's list, a doc's meta is editable through a form from that kind's schema.
		let ref = last.kindRef;
		let reach = ref?.inCrudContext;
		if (!ref && doc.kind !== "dive" && doc.kind !== "kind" && ctx.root) {
			const context = await api(contextQuery(ctx.root, false));
			const repoId = last.repo || bridge.id;
			ref = context.kinds.find((kind) => kind.name === doc.kind && kind.repoId === repoId)
				|| context.kinds.find((kind) => kind.name === doc.kind && kind.repoId === bridge.id);
			reach = context.repos.find((repo) => repo.id === repoId)?.inCrudContext;
			if (ref) last.kindRef = ref;
		}
		const kindDoc = ref ? await api("/api/doc?id=" + ref.id + "&repo=" + ref.repoId) : null;
		const form = kindDoc
			? metaForm(doc, last.repo || bridge.id, kindDoc.meta && kindDoc.meta.schema, reach, (msg) => select(path, row, msg))
			: null;
		const repo = doc.kind === "repo" ? await repoPanel(doc.id) : null;
		view.replaceChildren(...[docsMadeSection(doc), message, repo, featActions(doc, last), featLinker(doc, last), form].filter(Boolean), ...docBody(doc, true));
	} catch (err) { showError(err); }
}

/** Docs minted on this dive, linked from its live bridge record. */
function docsMadeSection(doc) {
	if (doc.kind !== "dive") return null;
	const made = doc.links.filter((link) => link.rel === "made");
	const rows = made.map((link) => el("li", {},
		link.type === "doc"
			? el("button", { class: "linkish", onclick: () => select([
				{ id: doc.id, name: label(doc), kind: "dive" },
				{ id: link.id, name: label(link), kind: link.kind, repo: link.repo },
			]) }, label(link))
			: el("span", { title: link.target }, link.target),
		" ", link.type === "doc" ? el("span", { class: "rel" }, link.kind + " · " + link.repoName) : null));
	return topSection("docs", "Docs", made.length
		? el("ul", { class: "doclist" }, rows)
		: el("p", { class: "rel" }, "No docs made on this dive yet."));
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
		view.replaceChildren(...[message, list].filter(Boolean), ...(doc.builtin ? [] : [schemaEditor(kind, doc, path, rerender)]), ...docBody(doc, false));
	} catch (err) { showError(err); }
}

${helmEditScript}
${helmSectionsScript}
${helmDiveScript}
${helmCreateScript}
${helmSyncScript}
${helmBranchesScript}
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
const events = new EventSource("/api/events?token=" + token);
events.addEventListener("boot", (event) => {
	if (boot && boot !== event.data) location.reload();
	boot = event.data;
});
// A dive or commit made outside the page -- a jump in a terminal, say -- is
// pushed as a new state; the first is only the baseline. A command streaming
// here refreshes when it ends, so the page leaves it be.
let bridgeState = null;
events.addEventListener("state", async (event) => {
	const next = JSON.parse(event.data);
	const last = bridgeState;
	bridgeState = next;
	if (!last || (last.dive === next.dive && last.head === next.head)) return;
	if (document.querySelector("#view .output.streaming")) return;
	try {
		await loadDives();
		await loadRoots();
		refreshSections();
		// A verb run here changes the dive too, often just after its output
		// ends; going home then would wipe that output.
		if (last.dive !== next.dive && !document.querySelector("#view > .output")) reset();
	} catch (err) {
		showError(err);
	}
});

${helmInternalsScript}
document.getElementById("headacts").append(noteButton());

Promise.all([loadRoots(), loadDives()]).then(() => {
	const path = currentPath();
	if (!path.length) return reset();
	refreshSections();
	if (location.hash === "#branch") return showBranch();
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
			// A kind page and a doc opened from its list come back as they were
			// opened: the kind as the Kinds section gives it, reach included.
			const at = path.length - 1;
			const kindAt = (i) => i >= 0 && docs[i] && docs[i].kind === "kind" && path[i].repo;
			const k = kindAt(at) ? at : kindAt(at - 1) ? at - 1 : -1;
			if (k < 0) return select(path);
			const step = path[k];
			return api(contextQuery(ctx.root, false))
				.then((context) => context.kinds.find((kind) => kind.id === step.id && kind.repoId === step.repo), () => null)
				.then((found) => {
					const kind = found || { id: step.id, name: docs[k].name, repoId: step.repo, inCrudContext: false };
					if (k === at) return showKind(kind, path);
					path[at].kindRef = kind;
					select(path);
				});
		});
}).catch(showError);
</script>
</body>
</html>
`;
