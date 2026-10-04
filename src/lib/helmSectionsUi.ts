/**
 * The Repos and Kinds sections atop the main pane, spliced into the page's
 * script. They follow the picker, the dive and every write; doc counts come
 * from a request of their own and fill in when it returns.
 */
export const helmSectionsScript = String.raw`
// --- repos and kinds --------------------------------------------------------

const OPEN_KEY = "helm-open-";

function sectionOpen(name) {
	try { return localStorage.getItem(OPEN_KEY + name) !== "closed"; } catch { return true; }
}

function rememberOpen(name, open) {
	try { localStorage.setItem(OPEN_KEY + name, open ? "open" : "closed"); } catch { /* a private window keeps nothing */ }
}

/** A collapsible section; whether it is open is this browser's to remember. */
function topSection(name, title, ...body) {
	const box = el("details", { class: "top", open: sectionOpen(name) ? "" : null }, el("summary", {}, title), body);
	box.addEventListener("toggle", () => rememberOpen(name, box.open));
	return box;
}

/** Bumped by each redraw, so an older one's late answer is dropped. */
let sectionsDrawn = 0;

/** Redraws both sections for what is in context: the dive's scopes, else the picked feat's. */
async function refreshSections() {
	const drawn = ++sectionsDrawn;
	try {
		const context = await api(contextQuery(ctx.root, false));
		if (drawn !== sectionsDrawn) return;
		const counts = [];
		const kinds = context.kinds.map((kind) => {
			const count = el("span", { class: "count", title: "counting" }, "…");
			counts.push({ kind, count });
			const path = [rootStep(ctx.root), { id: kind.id, name: kind.name, kind: "kind", repo: kind.repoId }];
			return el("li", { class: kind.inCrudContext ? "" : "out", title: kind.inCrudContext ? null : OUT_OF_REACH },
				el("button", { class: "linkish", onclick: () => showKind(kind, path) }, kind.name),
				" ", count, " ", el("span", { class: "rel" }, kind.repoName), " — ", kind.gist);
		});
		const unreadable = context.unreadable.length
			? el("p", { class: "rel" }, "Not hydrated, so their kbs cannot be read: " + context.unreadable.join(", ") + ".")
			: null;
		document.getElementById("top").replaceChildren(
			topSection("repos", "Repos", el("div", { class: "cards" }, context.repos.map(repoCard))),
			topSection("kinds", "Kinds", kinds.length ? el("ul", { class: "doclist" }, kinds)
				: el("p", { class: "rel" }, "No kinds in scope."), unreadable));
		const repos = [...new Set(context.kinds.map((kind) => kind.repoId))];
		if (!repos.length) return;
		const tally = await api("/api/kind-counts?repos=" + repos.join(","));
		if (drawn !== sectionsDrawn) return;
		for (const { kind, count } of counts) {
			count.textContent = String((tally[kind.repoId] || {})[kind.name] || 0);
			count.removeAttribute("title");
		}
	} catch (err) { showError(err); }
}
`;
