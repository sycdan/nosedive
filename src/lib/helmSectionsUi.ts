/**
 * The Repos and Kinds sections atop the main pane, spliced into the page's
 * script. They follow the picker, the dive and every write; doc counts come
 * from a request of their own and fill in when it returns.
 */
export const helmSectionsScript = String.raw`
// --- repos and kinds --------------------------------------------------------

const OPEN_KEY = "helm-open-";

function sectionOpen(name, byDefault = true) {
	try { const kept = localStorage.getItem(OPEN_KEY + name); return kept ? kept === "open" : byDefault; } catch { return byDefault; }
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

/** What the repo filter holds, kept across redraws. */
let repoFilter = "";

/** An out-of-scope repo on one line: name, hydrated or not, its actions; the gist on hover. */
function repoLine(repo) {
	return el("div", { class: "repoline", title: repo.gist },
		el("span", { class: "icon" }, repo.icon || "▢"), el("span", { class: "name" }, repo.name),
		repo.isBridge ? el("span", { class: "tag" }, "bridge") : null,
		repo.hydrated ? fact("ok", "hydrated") : fact("", "not hydrated"),
		el("span", { class: "gap" }), cardActions(repo), scopeActions(repo));
}

/** In-scope repos as cards, the rest as lines behind "show all"; the filter narrows both by name or gist. */
function reposSection(repos) {
	const shown = repos.map((repo) => ({ repo, node: repo.inScope ? repoCard(repo) : repoLine(repo) }));
	const cards = shown.filter(({ repo }) => repo.inScope).map(({ node }) => node);
	const lines = shown.filter(({ repo }) => !repo.inScope).map(({ node }) => node);
	const summary = el("summary", {});
	const rest = el("details", { class: "rest", open: sectionOpen("repos-rest", false) ? "" : null },
		summary, el("div", { class: "repolines" }, lines));
	rest.addEventListener("toggle", () => rememberOpen("repos-rest", rest.open));
	const filter = el("input", { type: "search", class: "repofilter", placeholder: "filter by name or gist", "aria-label": "Filter repos" });
	filter.value = repoFilter;
	const apply = () => {
		repoFilter = filter.value;
		const words = repoFilter.trim().toLowerCase();
		let more = 0;
		for (const { repo, node } of shown) {
			node.hidden = words !== "" && !(repo.name + " " + repo.gist).toLowerCase().includes(words);
			if (!repo.inScope && !node.hidden) more++;
		}
		summary.textContent = "show all (" + more + ")";
	};
	filter.addEventListener("input", apply);
	apply();
	return topSection("repos", "Repos", filter, el("div", { class: "cards" }, cards), lines.length ? rest : null);
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
		// A redraw mid-typing keeps the filter's focus.
		const typing = document.activeElement && document.activeElement.classList.contains("repofilter");
		document.getElementById("top").replaceChildren(
			reposSection(context.repos),
			topSection("kinds", "Kinds", kinds.length ? el("ul", { class: "doclist" }, kinds)
				: el("p", { class: "rel" }, "No kinds in scope."), unreadable));
		if (typing) {
			const box = document.querySelector("#top .repofilter");
			box.focus();
			box.setSelectionRange(box.value.length, box.value.length);
		}
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

// --- scope edits ------------------------------------------------------------

/** What a card's scope edit changes: the dive in context, else the picked feat, else the root (the backlog at level 0). */
function scopeTarget() {
	const dive = diveInContext();
	if (dive) return { dive };
	const doc = ctx.feat || ctx.root;
	return doc ? { doc } : null;
}

/** Runs one scope edit, says how it went in the corner -- a refusal in nosedive's words -- and redraws both sections. */
async function runScopeEdit(title, body) {
	let text = "";
	try {
		const res = await fetch("/api/run", {
			method: "POST",
			headers: { "x-helm-token": token, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		text = res.ok ? await res.text() : (await res.json()).error;
	} catch (err) {
		text = String(err.message || err);
	}
	const failed = !/\[exit 0\]\s*$/.test(text);
	syncNotice(title + (failed ? " refused" : ""), text.replace(/\[exit \d+\]\s*$/, "").trim(), failed);
	// A refusal is shown open: the why is the point.
	if (failed) document.querySelector("#syncnotice .linkish").click();
	await loadDives();
	refreshSections();
}

/** A button that turns the card's action row into a one-field form. */
function inlineForm(box, label, input, submit) {
	const open = el("button", { class: "act jump" }, label);
	open.addEventListener("click", () => {
		const form = el("form", { class: "make" }, input, el("button", { type: "submit" }, label));
		form.addEventListener("submit", (event) => { event.preventDefault(); submit(input.value.trim()); });
		box.replaceChildren(form);
		input.select();
	});
	return open;
}

/**
 * A card's scope edits. On a dive: repin (at its work branch's tip unless
 * another ref is typed), drop, or add, writable or read-only. With none, on
 * the picked feat or the backlog: add, drop, or set the work branch -- a feat
 * scope has no pin. A feat's first own scope also copies what it inherited,
 * server-side, so its dives keep it.
 */
function scopeActions(repo) {
	const target = scopeTarget();
	if (!target) return null;
	const box = el("div", { class: "cardacts" });
	const field = (label, value, placeholder) => {
		const input = el("input", { type: "text", "aria-label": label, placeholder });
		input.value = value || "";
		return input;
	};
	const run = (label, body) => runScopeEdit(label + " " + repo.name, Object.assign({ repo: repo.id }, target, body));
	if (!repo.scope) {
		box.append(inlineForm(box, "Add scope",
			field("work branch", "", target.dive ? "work branch (else the feat's)" : "work branch (none)"),
			(branch) => run("Add scope", { verb: target.dive ? "upscope" : "feat-scope", branch })),
			...(target.dive ? [el("button", { class: "act jump", title: "Pinned, with no work branch: the dive reads it, never lands to it",
				onclick: () => run("Add read-only", { verb: "upscope", readOnly: true }) }, "Add read-only")] : []));
		return box;
	}
	const drop = () => run("Drop scope", target.dive ? { verb: "unscope" } : { verb: "feat-scope", drop: true });
	// Off the backlog, the bridge leaves every new dive's scopes.
	const bridgeOffBacklog = repo.isBridge && !target.dive && backlogRoot && target.doc === backlogRoot.ref;
	box.append(target.dive
		? inlineForm(box, "Repin", field("ref to repin at", repo.scope.workBranch || repo.trunk),
			(ref) => run("Repin", { verb: "repin", ref }))
		: inlineForm(box, "Work branch", field("work branch", repo.scope.workBranch, "none"),
			(branch) => run("Work branch", { verb: "feat-scope", branch })),
		bridgeOffBacklog
			? el("button", { class: "act pack", onclick: () => confirmDialog({
				verb: "Drop", cls: "pack", target: repo.name + " from the backlog",
				detail: "New dives then cannot write the bridge kb, unless their feat scopes the bridge.",
				act: drop,
			}) }, "Drop scope")
			: confirmButton("Drop scope", "pack", drop));
	return box;
}
`;
