/**
 * The page's left tree and picker, spliced into its script. The picked doc --
 * the backlog when nothing is -- heads the tree, then the feats it links and
 * theirs -- dives are cards in the main view, never rows; repos and kinds sit
 * atop the main view.
 */
export const helmTreeScript = String.raw`
// --- tree -------------------------------------------------------------------

/** The backlog memo: the tree's head when nothing is picked. */
let backlogRoot = null;
/** The backlog and the docs the picker offers, by the ref the server names them with. */
const rootNames = new Map();
const rootCards = new Map();
const PICK_KEY = "helm-pick";
/** The picked doc's feats, as its links name them: what Add as feat offers to nest under. */
let rootFeats = [];

function rememberedPick() {
	try { return localStorage.getItem(PICK_KEY); } catch { return null; }
}

function rememberPick(ref) {
	try { localStorage.setItem(PICK_KEY, ref); } catch { /* a private window keeps nothing */ }
}

function rootStep(ref) {
	const card = rootCards.get(ref);
	return { id: card ? card.id : ref, repo: card && card.repo, name: rootNames.get(ref) || ref, kind: "root" };
}

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

/** The picker in the header: the whole backlog, then the docs picker-level offers; locked on a dive, hidden at level 0. */
function renderPicker(listing) {
	const picker = document.getElementById("rootpick");
	picker.hidden = !listing.level;
	const options = [backlogRoot, ...listing.choices].filter(Boolean)
		.map((pick) => el("option", { value: pick.ref }, rootNames.get(pick.ref)));
	picker.replaceChildren(...options);
	picker.value = ctx.root || "";
	picker.disabled = listing.locked;
	picker.title = listing.locked ? "On a dive, the pick is the one its feat is under" : "Pick what the tree shows";
	picker.onchange = async () => {
		rememberPick(picker.value);
		Object.assign(ctx, { root: picker.value, feat: null, repo: null, kind: null });
		await loadRoots();
		reset();
	};
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

/** Reads the pick and fills the tree with it: the picked doc and its .feat children, or the whole backlog. */
async function loadRoots() {
	const wanted = ctx.root || rememberedPick();
	const listing = await api("/api/picker" + (wanted ? "?pick=" + encodeURIComponent(wanted) : ""));
	bridge = listing.bridge;
	renderBranch(bridge.branch);
	backlogRoot = listing.backlog || null;
	rootIds.clear();
	rootNames.clear();
	rootCards.clear();
	for (const pick of [backlogRoot, ...listing.choices].filter(Boolean)) {
		rootIds.add(pick.id);
		rootNames.set(pick.ref, display(pick));
		rootCards.set(pick.ref, pick);
	}
	const root = listing.pick || (backlogRoot && backlogRoot.ref) || null;
	if (ctx.root !== root) Object.assign(ctx, { feat: null, repo: null, kind: null });
	ctx.root = root;
	renderPicker(listing);
	rootFeats = listing.feats;
	const home = ctx.root ? [rootStep(ctx.root)] : [];
	const items = [];
	if (ctx.root)
		items.push(section(rootNames.get(ctx.root), (row) => { highlight(row); reset(); }),
			...groupedRows(listing.feats, (feat, hideRel) => node(feat, home, hideRel, Boolean(listing.pick))));
	document.getElementById("tree").replaceChildren(...items);
}
`;
