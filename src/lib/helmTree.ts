/**
 * The page's left tree, spliced into its script: the repos in scope -- the
 * dive's, else the deck's -- each expanding to its kinds and each kind to its
 * docs, the rest folded behind "show all". Feats are the deck picker's.
 */
export const helmTreeScript = String.raw`
// --- tree -------------------------------------------------------------------

/** A doc's name in the tree and the breadcrumbs. */
function label(doc) {
	return display(doc);
}

/** A row: a twisty that expands load() into children lazily, and a label. */
function branch(cls, parts, title, load, onPick, onToggle) {
	const li = el("li", { class: cls });
	const children = el("ul", { hidden: "" });
	const twisty = el("button", { class: "twisty", "aria-label": "expand", disabled: load ? null : "" }, load ? "▶" : "");
	const labelButton = el("button", { class: "label", title }, parts);
	const row = el("div", { class: "row" }, twisty, labelButton);
	let loaded = false;
	const fill = async () => {
		try {
			const items = await load();
			children.replaceChildren(...items);
			twisty.disabled = !items.length;
			if (items.length) twisty.textContent = children.hidden ? "▶" : "▼";
			if (!items.length) { twisty.disabled = true; twisty.textContent = ""; }
		} catch (err) { showError(err); }
	};
	const self = {
		li, row,
		refill: () => { if (loaded) fill(); },
		close: () => { children.hidden = true; twisty.textContent = "▶"; },
		open: () => { if (load && children.hidden) twisty.click(); },
	};
	twisty.addEventListener("click", () => {
		const open = children.hidden;
		children.hidden = !open;
		twisty.textContent = open ? "▼" : "▶";
		if (open && !loaded) { loaded = true; fill(); }
		if (onToggle) onToggle(open, self);
	});
	if (onPick) labelButton.addEventListener("click", () => onPick(row));
	li.append(row, children);
	return self;
}

/** The branch the bridge has checked out, and how far it is from trunk. */
function renderBranch(branch) {
	const badge = document.getElementById("branch");
	const drift = [branch.ahead ? "↑" + branch.ahead : null, branch.behind ? "↓" + branch.behind : null].filter(Boolean).join(" ");
	badge.textContent = branch.name + (drift ? " " + drift : "");
	badge.title = branch.ahead == null ? "no origin/" + branch.trunk + " to compare with"
		: branch.ahead + " ahead of, " + branch.behind + " behind origin/" + branch.trunk;
	badge.classList.toggle("off", branch.name !== branch.trunk);
	badge.onclick = showBranch;
}

/** What the repo filter holds, kept across redraws. */
let repoFilter = "";
/** Bumped by each redraw, so an older one's late answer is dropped. */
let sectionsDrawn = 0;
/** The context the tree last drew: a repo's page takes its card from it. */
let treeContext = null;
/** The repos and kinds expanded, kept across redraws. */
const treeOpen = new Set();

function rememberTreeOpen(key) {
	return (open) => { if (open) treeOpen.add(key); else treeOpen.delete(key); };
}

function repoStep(repo) {
	return { id: repo.id, name: repo.name, kind: "repo" };
}

/** A kind under its repo: its count fills in apart, and it expands into its docs. */
function kindRow(kind, repo) {
	const count = el("span", { class: "count", title: "counting" }, "…");
	const path = kind.undeclared ? [repoStep(repo)]
		: [repoStep(repo), { id: kind.id, name: kind.name, kind: "kind", repo: kind.repoId }];
	const docs = async () => (await api("/api/kind-docs?repo=" + kind.repoId + "&kind=" + encodeURIComponent(kind.name)))
		.map((d) => branch("doc", [el("span", { class: "text" }, d.title)], d.gist, null,
			(row) => select([...path, { id: d.id, name: d.title, kind: kind.name, repo: kind.repoId, kindRef: kind.undeclared ? null : kind }], row)).li);
	const key = "kind:" + kind.repoId + ":" + (kind.undeclared ? "undeclared:" + kind.name : kind.id);
	const node = branch("kindrow" + (kind.inCrudContext ? "" : " out"), [el("span", { class: "text" }, kind.name), count],
		kind.inCrudContext ? kind.gist : OUT_OF_REACH, docs, kind.undeclared ? null : (row) => showKind(kind, path, row), rememberTreeOpen(key));
	if (kind.undeclared) {
		node.row.append(el("span", { class: "tag" }, "no kind doc"));
		node.row.querySelector(".label").addEventListener("click", () => node.open());
	}
	return { kind, count, node, key };
}

/** A repo: in scope, it expands into its kinds; its status, a dot, fills in apart. */
function repoRow(repo, kinds, unreadable) {
	const out = repo.inCrudContext === false;
	const parts = [el("span", { class: "icon" }, repo.icon || "▢"), el("span", { class: "text" }, repo.name),
		repo.isBridge ? el("span", { class: "tag" }, "bridge") : null,
		el("span", { class: "dot", title: "checking…" })];
	const rows = kinds.map((kind) => kindRow(kind, repo));
	const note = (text) => [el("li", { class: "note" }, text)];
	const load = !repo.inScope ? null : async () => unreadable ? note("Not hydrated, so its kb cannot be read.")
		: rows.length ? rows.map(({ node }) => node.li) : note("No kinds.");
	const node = branch("repo" + (out ? " out" : ""), parts, repo.gist + (out ? "\n" + OUT_OF_REACH : ""), load,
		(row) => select([repoStep(repo)], row), rememberTreeOpen("repo:" + repo.id));
	return { repo, node, rows, key: "repo:" + repo.id };
}

/** A repo's status as a dot: green at trunk, amber off it, grey not hydrated; the details on hover. */
function treeStatus(shown, status) {
	const h = status.hydrated;
	const n = status.nosedive;
	const dot = shown.node.row.querySelector(".dot");
	dot.className = "dot" + (h ? (h.atTrunk ? " ok" : " warn") : "");
	dot.title = (h ? (h.atTrunk ? "at " : "off ") + shown.repo.trunk + " " + h.commit.slice(0, 8) : "not hydrated")
		+ " · " + (n === "unknown" ? "nosedive ?" : n ? "nosedive L" + n.level : "no nosedive");
}

/**
 * Redraws the tree for what is in context -- the dive's scopes, else the
 * deck's: a filter, the repos in scope, the rest behind "show all". Statuses
 * load eight repos a request, in-scope first, and kind counts apart.
 */
async function refreshSections() {
	const drawn = ++sectionsDrawn;
	try {
		const context = await api(contextQuery(ctx.root || (backlogRoot && backlogRoot.ref), false));
		if (drawn !== sectionsDrawn) return;
		treeContext = context;
		const shown = context.repos.map((repo) =>
			repoRow(repo, context.kinds.filter((kind) => kind.repoId === repo.id), context.unreadable.includes(repo.name)));
		const heading = el("li", { class: "section" }, "Repos (0/" + shown.length + ")");
		const summary = el("summary", {});
		const restList = el("ul", {}, shown.filter(({ repo }) => !repo.inScope).map(({ node }) => node.li));
		const rest = el("details", { class: "rest", open: sectionOpen("repos-rest", false) ? "" : null }, summary, restList);
		rest.addEventListener("toggle", () => rememberOpen("repos-rest", rest.open));
		const filter = el("input", { type: "search", class: "repofilter", placeholder: "filter repos by name or gist", "aria-label": "Filter repos" });
		filter.value = repoFilter;
		const apply = () => {
			repoFilter = filter.value;
			const words = repoFilter.trim().toLowerCase();
			let more = 0;
			for (const { repo, node } of shown) {
				node.li.hidden = words !== "" && !(repo.name + " " + repo.gist).toLowerCase().includes(words);
				if (!repo.inScope && !node.li.hidden) more++;
			}
			summary.textContent = "show all (" + more + ")";
		};
		filter.addEventListener("input", apply);
		apply();
		// A redraw mid-typing keeps the filter's focus.
		const typing = document.activeElement && document.activeElement.classList.contains("repofilter");
		document.getElementById("tree").replaceChildren(el("li", { class: "filter" }, filter), heading,
			...shown.filter(({ repo }) => repo.inScope).map(({ node }) => node.li),
			...(restList.children.length ? [el("li", { class: "restfold" }, rest)] : []));
		if (typing) { filter.focus(); filter.setSelectionRange(filter.value.length, filter.value.length); }
		for (const { node, rows, key } of shown) {
			if (treeOpen.has(key)) node.open();
			for (const kind of rows) if (treeOpen.has(kind.key)) kind.node.open();
		}
		// In-scope repos come first. Each request is bounded, and a later redraw
		// invalidates every answer still in flight.
		void (async () => {
			let loaded = 0;
			for (let i = 0; i < shown.length; i += 8) {
				const batch = shown.slice(i, i + 8);
				const statuses = await api("/api/repo-statuses?ids=" + batch.map(({ repo }) => repo.id).join(","));
				if (drawn !== sectionsDrawn) return;
				for (const one of batch) {
					if (statuses[one.repo.id]) treeStatus(one, statuses[one.repo.id]);
					loaded++;
				}
				heading.textContent = loaded === shown.length ? "Repos" : "Repos (" + loaded + "/" + shown.length + ")";
			}
			if (!shown.length) heading.textContent = "Repos";
		})().catch((err) => { if (drawn === sectionsDrawn) showError(err); });
		const repos = context.repos.filter((repo) => repo.inScope && !context.unreadable.includes(repo.name)).map((repo) => repo.id);
		if (!repos.length) return;
		const tally = await api("/api/kind-counts?repos=" + repos.join(","));
		if (drawn !== sectionsDrawn) return;
		for (const { repo, rows, node } of shown) {
			const declared = new Set(rows.map(({ kind }) => kind.name));
			for (const name of Object.keys(tally[repo.id] || {}).sort()) {
				if (declared.has(name)) continue;
				const row = kindRow({ name, repoId: repo.id, undeclared: true, inCrudContext: repo.inCrudContext, gist: "no kind doc" }, repo);
				rows.push(row);
				if (treeOpen.has(row.key)) row.node.open();
			}
			for (const { kind, count } of rows) {
				count.textContent = String((tally[kind.repoId] || {})[kind.name] || 0);
				count.removeAttribute("title");
			}
			node.refill();
		}
	} catch (err) { showError(err); }
}
`;
