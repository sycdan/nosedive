/**
 * The page's left tree and picker, spliced into its script. The picked doc --
 * the first offered feat by default -- heads the tree, then the feats it links and
 * theirs -- dives are cards in the main view, never rows; repos and kinds sit
 * atop the main view.
 */
export const helmTreeScript = String.raw`
// --- tree -------------------------------------------------------------------

/** A doc's name in the tree and the breadcrumbs. */
function label(doc) {
	return display(doc);
}

/** Dives are cards in the main view, so the tree leaves them out. */
function notADive(link) {
	return !/(^|\.)dive$/.test(link.rel || "") && link.kind !== "dive";
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
			if (!items.length) { twisty.disabled = true; twisty.textContent = ""; }
		} catch (err) { showError(err); }
	};
	const self = {
		li, row,
		refill: () => { if (loaded) fill(); },
		close: () => { children.hidden = true; twisty.textContent = "▶"; },
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

/** Splits items into feat groups, named for what their rel says before .feat in first-seen order, and the rest. */
function featGroups(items) {
	const groups = [];
	const rest = [];
	for (const item of items) {
		const m = /^(.+)\.feat$/.exec(item.rel || "");
		if (!m) { rest.push(item); continue; }
		let group = groups.find((g) => g.group === m[1]);
		if (!group) { group = { group: m[1], items: [] }; groups.push(group); }
		group.items.push(item);
	}
	return { groups, rest };
}

/** A level's rows: each feat group under its heading, rows without their rel, then the rest as they are. */
function groupedRows(items, render) {
	const { groups, rest } = featGroups(items);
	const rows = [];
	for (const { group, items: members } of groups)
		rows.push(el("li", { class: "featgroup" }, group), ...members.map((item) => render(item, true)));
	return [...rows, ...rest.map((item) => render(item, false))];
}

/**
 * One doc in the tree; it expands into its links, never into an ancestor. hideRel leaves off the rel its group heading already says.
 * A doc in another repo carries that repo, which reading it needs; a link helm cannot read is unresolved.
 */
function node(item, ancestors, hideRel, featsOnly) {
	if (item.type !== "doc") {
		const parts = [el("span", { class: "text" }, item.target), item.rel && !hideRel ? el("span", { class: "rel" }, item.rel) : null];
		const li = el("li", { class: item.type });
		const link = item.type === "url"
			? el("a", { class: "label", href: item.target, target: "_blank", rel: "noopener noreferrer", title: item.target }, parts)
			: el("button", { class: "label", title: (item.type === "unresolved" ? "Unresolved: " : "") + item.target, disabled: "" }, parts);
		li.append(el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), link));
		return li;
	}
	const cycle = ancestors.some((a) => a.id === item.id);
	const step = { id: item.id, name: label(item), kind: item.kind, rel: item.rel, repo: item.repo };
	const path = [...ancestors, step];
	const parts = [
		el("span", { class: "kind" }, item.kind),
		el("span", { class: "text" }, label(item)),
		item.rel && !hideRel ? el("span", { class: "rel" }, item.rel) : null,
		cycle ? el("span", { class: "rel" }, "↺") : null,
	];
	const load = cycle || (featsOnly && !item.hasFeats) ? null : featsOnly
		? async () => groupedRows(await api("/api/feats?ref=" + encodeURIComponent(item.ref)), (feat, hideRel) => node(feat, path, hideRel, true))
		: async () => {
			const doc = await api("/api/doc?id=" + item.id + (item.repo ? "&repo=" + item.repo : ""));
			return groupedRows(doc.links.filter(notADive), (link, hideRel) => node(link, path, hideRel));
		};
	return branch(cycle ? "cycle" : "doc", parts, item.gist, load, (row) => select(path, row)).li;
}

/** A heading in the tree; the root's opens that root. */
function section(title, onPick) {
	const heading = el("button", { class: "label", disabled: onPick ? null : "" }, el("span", { class: "text" }, title));
	if (onPick) heading.addEventListener("click", () => onPick(row));
	const row = el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), heading);
	return el("li", { class: "section" }, row);
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

/** The deck heads the tree, its .feat children below. */
function drawTree() {
	const home = ctx.root ? [rootStep(ctx.root)] : [];
	const items = [];
	if (ctx.root)
		items.push(section(rootNames.get(ctx.root), (row) => { highlight(row); reset(); }),
			...groupedRows(rootFeats, (feat, hideRel) => node(feat, home, hideRel, true)));
	document.getElementById("tree").replaceChildren(...items);
}
`;
