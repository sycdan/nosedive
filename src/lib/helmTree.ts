/**
 * The page's left tree, spliced into its script. Top to bottom: the bridge
 * deck's feats, one Repos and one Kinds section showing the open deck (the
 * bridge deck, read-only, when none is open), and -- on a dive -- the other
 * decks, one open at a time.
 */
export const helmTreeScript = String.raw`
// --- tree -------------------------------------------------------------------

/** The backlog memo, shown as the bridge deck at the root of the tree. */
let bridgeDeck = null;
const deckNames = new Map();
let openDeckBranch = null;

/** The deck the Repos and Kinds sections show: the open one, else the bridge deck. */
function openDeck() {
	return ctx.deck || (bridgeDeck ? bridgeDeck.id : null);
}

function deckStep(id) {
	return { id, name: deckNames.get(id) || id, kind: "deck" };
}

/** A doc's name in the tree and the breadcrumbs; the backlog is always the bridge deck. */
function label(doc) {
	return bridgeDeck && doc.id === bridgeDeck.id ? "Bridge deck" : display(doc);
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

/** Opening a deck closes the one open before it and points Repos and Kinds at it. */
function toggleDeck(deckId, open, b) {
	if (open) {
		if (openDeckBranch && openDeckBranch !== b) openDeckBranch.close();
		openDeckBranch = b;
		Object.assign(ctx, { deck: deckId, feat: null, repo: null, kind: null });
	} else if (openDeckBranch === b) {
		openDeckBranch = null;
		Object.assign(ctx, { deck: null, feat: null, repo: null, kind: null });
	}
	refreshGroups();
}

/** One doc in the tree; it expands into its links, never into an ancestor. */
function node(item, ancestors) {
	if (item.type !== "doc") {
		const parts = [el("span", { class: "text" }, item.target), item.rel ? el("span", { class: "rel" }, item.rel) : null];
		const li = el("li", { class: item.type });
		const link = item.type === "url"
			? el("a", { class: "label", href: item.target, target: "_blank", rel: "noopener noreferrer", title: item.target }, parts)
			: el("button", { class: "label", title: item.target, disabled: "" }, parts);
		li.append(el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), link));
		return li;
	}
	const cycle = ancestors.some((a) => a.id === item.id);
	const step = { id: item.id, name: label(item), kind: item.kind, rel: item.rel };
	const path = [...ancestors, step];
	const parts = [
		el("span", { class: "kind" }, item.kind),
		el("span", { class: "text" }, label(item)),
		item.rel ? el("span", { class: "rel" }, item.rel) : null,
		cycle ? el("span", { class: "rel" }, "↺") : null,
	];
	const load = cycle ? null : async () => {
		const doc = await api("/api/doc?id=" + item.id);
		return doc.links.map((link) => node(link, path));
	};
	const b = branch((item.isDeck ? "deck " : "") + (cycle ? "cycle" : "doc"), parts, item.gist, load,
		(row) => select(path, row), item.isDeck ? (open, self) => toggleDeck(item.id, open, self) : null);
	return b.li;
}

/**
 * The Repos or Kinds section, refilled whenever the context changes. On the
 * bridge deck it is for looking: crud needs a deck of its own open.
 */
function group(type) {
	const title = type === "repos" ? "Repos" : "Kinds";
	const load = async () => {
		const deckId = openDeck();
		if (!deckId) return [];
		const context = await api(contextQuery(deckId, type === "kinds"));
		const readOnly = bridgeDeck && deckId === bridgeDeck.id;
		const deckPath = [deckStep(deckId)];
		if (type === "repos")
			return context.repos.map((repo) => repoItem(readOnly ? { ...repo, inCrudContext: false } : repo, deckId, deckPath));
		const kinds = context.kinds.map((kind) => kindItem(readOnly ? { ...kind, inCrudContext: false } : kind, deckId, deckPath));
		const blind = context.unreadable.map((name) =>
			el("li", { class: "file" }, el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }),
				el("button", { class: "label", disabled: "", title: "not hydrated, so its kb cannot be read" },
					el("span", { class: "text" }, name + ": kb not readable")))));
		return [...kinds, ...blind];
	};
	const b = branch("group", [el("span", { class: "text" }, title)], null, load,
		(row) => showGroup(type, openDeck(), [deckStep(openDeck()), { id: "#" + type, name: title }], row));
	groups.push(b);
	return b.li;
}

function repoItem(repo, deckId, deckPath) {
	const picked = ctx.repo === repo.id && openDeck() === deckId;
	const li = el("li", { class: "repo" + (repo.inCrudContext ? "" : " out") + (picked ? " picked" : "") });
	const button = el("button", { class: "label", title: repo.inCrudContext ? repo.gist : OUT_OF_REACH },
		el("span", { class: "icon" }, repo.icon || "▢"), el("span", { class: "text" }, repo.name));
	const row = el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), button);
	button.addEventListener("click", () => {
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
	const button = el("button", { class: "label", title: kind.inCrudContext ? kind.gist : OUT_OF_REACH },
		el("span", { class: "text" }, kind.name), el("span", { class: "count" }, String(kind.count)),
		el("span", { class: "rel" }, kind.repoName));
	const row = el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), button);
	button.addEventListener("click", () => {
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

/** A heading in the tree; the bridge deck's opens that deck. */
function section(title, onPick) {
	const heading = el("button", { class: "label", disabled: onPick ? null : "" }, el("span", { class: "text" }, title));
	if (onPick) heading.addEventListener("click", () => onPick(row));
	const row = el("div", { class: "row" }, el("button", { class: "twisty", disabled: "" }), heading);
	return el("li", { class: "section" }, row);
}

async function loadDecks() {
	const listing = await api("/api/decks");
	bridge = listing.bridge;
	bridgeDeck = listing.bridgeDeck || null;
	deckIds.clear();
	deckNames.clear();
	if (bridgeDeck) { deckIds.add(bridgeDeck.id); deckNames.set(bridgeDeck.id, "Bridge deck"); }
	for (const deck of listing.decks) { deckIds.add(deck.id); deckNames.set(deck.id, display(deck)); }
	groups.length = 0;
	openDeckBranch = null;
	const home = bridgeDeck ? [deckStep(bridgeDeck.id)] : [];
	const items = [];
	if (bridgeDeck)
		items.push(section("Bridge deck", (row) => select(home, row)), ...listing.feats.map((feat) => node(feat, home)));
	items.push(group("repos"), group("kinds"));
	if (listing.diving && listing.decks.length)
		items.push(section("Decks"), ...listing.decks.map((deck) => node({ type: "doc", isDeck: true, ...deck }, [])));
	document.getElementById("tree").replaceChildren(...items);
}
`;
