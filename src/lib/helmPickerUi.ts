/**
 * The deck picker in the header, spliced into the page's script: one flat,
 * filterable list of the feats the backlog reaches, the chosen one kept per
 * viewer as the chain of refs that leads to it.
 * @see kb/01a11be7-0691-7e74-9f93-afac333f04f3.md
 */
export const helmPickerScript = String.raw`
// --- deck picker ------------------------------------------------------------

/** The backlog memo, used for actions that target it explicitly. */
let backlogRoot = null;
/** The picker's rows and the deck by ref: their names, and what opening one needs. */
const rootNames = new Map();
const rootCards = new Map();
/** The deck's feats, as its links name them: what Add as feat offers to nest under. */
let rootFeats = [];
const DECK_KEY = "helm-deck";
/** The rows, the default deck's chain, the deck's own, the dive's lock, and what Load has read, by ref. */
const deck = { rows: [], defaultChain: null, chain: null, locked: null, loads: new Map() };

function rememberedChain() {
	try {
		const chain = JSON.parse(localStorage.getItem(DECK_KEY));
		return Array.isArray(chain) && chain.length && chain.every((ref) => typeof ref === "string") ? chain : null;
	} catch { return null; }
}

function rememberChain(chain) {
	try { localStorage.setItem(DECK_KEY, JSON.stringify(chain)); } catch { /* a private window keeps nothing */ }
}

function rootStep(ref) {
	const card = rootCards.get(ref);
	return { id: card ? card.id : ref, repo: card && card.repo, name: rootNames.get(ref) || ref, kind: "root" };
}

/** Path by path, so a doc's rows sit right under it; then by name. The server sorts the same way. */
function deckOrder(a, b) {
	const left = [...a.path, a.name];
	const right = [...b.path, b.name];
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const order = left[i].localeCompare(right[i]);
		if (order) return order;
	}
	return left.length - right.length;
}

/** Loaded rows join the list; one replaces the unread row with its ref. */
function mergeRows(rows) {
	for (const row of rows) {
		const at = deck.rows.findIndex((r) => r.ref === row.ref);
		if (at < 0) deck.rows.push(row);
		else if (deck.rows[at].load) deck.rows[at] = row;
	}
	deck.rows.sort(deckOrder);
	for (const row of [...deck.rows, ...(deck.locked ? [deck.locked] : [])]) {
		rootNames.set(row.ref, display(row));
		rootCards.set(row.ref, row);
	}
}

/** Load: reads a row the way crud reads a repo nobody hydrated, filling in its title and the feats it links. */
async function loadRow(row) {
	const query = row.chain.map((ref) => "chain=" + encodeURIComponent(ref)).join("&");
	const { rows } = await api("/api/picker/load?" + query);
	deck.loads.set(row.ref, rows);
	mergeRows(rows);
}

/** The row a chain of refs leads to, loading each step that needs it; throws at a step it cannot read. */
async function settleChain(chain) {
	let row = null;
	for (const ref of chain) {
		row = deck.rows.find((r) => r.ref === ref);
		if (!row) throw new Error("nothing links " + ref + " there now");
		if (row.load) {
			await loadRow(row);
			row = deck.rows.find((r) => r.ref === ref);
		}
	}
	if (!row || row.container || row.load) throw new Error(chain[chain.length - 1] + " is not a feat");
	return row;
}

/**
 * Reads the picker and settles the deck: the dive's feat on a dive; else this
 * viewer's chain, loaded step by step, falling back to the default -- the
 * first feat the backlog links -- with a notice when a step cannot be read.
 */
async function loadRoots() {
	const listing = await api("/api/picker");
	bridge = listing.bridge;
	renderBranch(bridge.branch);
	backlogRoot = listing.backlog || null;
	deck.defaultChain = listing.defaultChain || null;
	deck.locked = listing.locked || null;
	deck.rows = listing.rows.slice();
	rootNames.clear();
	rootCards.clear();
	mergeRows([...deck.loads.values()].flat());
	let picked = deck.locked;
	const wanted = deck.chain || rememberedChain();
	if (!picked && wanted)
		picked = await settleChain(wanted).catch((err) => {
			syncNotice("Deck reset", "The deck could not be read: " + err.message + ". Showing the default deck.", true);
			return null;
		});
	if (!picked && deck.defaultChain) picked = await settleChain(deck.defaultChain).catch(() => null);
	if (!deck.locked) deck.chain = picked ? picked.chain : null;
	const root = picked ? picked.ref : null;
	rootIds.clear();
	if (picked) rootIds.add(picked.id);
	if (ctx.root !== root) Object.assign(ctx, { feat: null, repo: null, kind: null });
	ctx.root = root;
	renderPicker();
	rootFeats = root ? await api("/api/feats?ref=" + encodeURIComponent(root)) : [];
	drawTree();
}

async function chooseDeck(row) {
	rememberChain(row.chain);
	deck.chain = row.chain;
	Object.assign(ctx, { root: row.ref, feat: null, repo: null, kind: null });
	await loadRoots();
	reset();
}

/** Two tones: the name, behind the path it was reached through, then the title. */
function deckText(row) {
	const name = display(row);
	return [el("span", { class: "dname" }, [...(row.path || []), name].join(" › ")),
		row.title && row.title !== name ? el("span", { class: "dtitle" }, row.title) : null];
}

/** The picker: a button naming the deck. On a dive it is locked to the dive's feat, and says so. */
function renderPicker() {
	const box = document.getElementById("deckpick");
	const current = ctx.root ? rootCards.get(ctx.root) : null;
	const button = el("button", { class: "deckbtn", type: "button", disabled: deck.locked ? "" : null,
		title: deck.locked ? "On a dive the deck is the dive's feat" : "Pick the deck" },
		el("span", { class: "icon" }, deck.locked ? "🔒" : "🏗️"),
		current ? deckText(current) : el("span", { class: "dtitle" }, "no feats"),
		el("span", { class: "dtitle" }, deck.locked ? "· the dive's feat" : "▾"));
	button.addEventListener("click", () => openDeckList(box));
	box.replaceChildren(button);
}

/** 🏗️ a feat, the deck to pick; 🌉 a backlog, listed with its feats under it but never picked. */
function deckItem(row, close, redraw) {
	const pick = el("button", { class: "deckrow" + (row.ref === ctx.root ? " current" : ""), type: "button",
		disabled: row.container || row.load ? "" : null, title: row.gist },
		el("span", { class: "icon" }, row.load ? "▢" : row.container ? "🌉" : "🏗️"), ...deckText(row));
	pick.addEventListener("click", () => { close(); chooseDeck(row); });
	if (!row.load) return el("li", {}, pick);
	const load = el("button", { class: "act jump", type: "button", title: "Read " + row.ref }, "Load");
	load.addEventListener("click", async () => {
		load.disabled = true;
		load.textContent = "Loading…";
		try {
			await loadRow(row);
			redraw();
		} catch (err) {
			load.disabled = false;
			load.textContent = "Load";
			syncNotice("Load refused", String(err.message || err), true);
		}
	});
	return el("li", {}, pick, load);
}

/** The list under the picker, filtered by path, name, title or gist; Esc or a click outside closes it. */
function openDeckList(box) {
	if (box.querySelector(".deckpop")) return;
	const filter = el("input", { type: "search", class: "deckfilter", placeholder: "filter feats", "aria-label": "Filter feats" });
	const list = el("ul", { class: "decklist" });
	const pop = el("div", { class: "deckpop" }, filter, list);
	const outside = (event) => { if (!box.contains(event.target)) close(); };
	const close = () => { pop.remove(); document.removeEventListener("mousedown", outside); };
	const draw = () => {
		const words = filter.value.trim().toLowerCase();
		const rows = [backlogRoot, ...deck.rows].filter((row) => row && (!words ||
			[...(row.path || []), row.name, row.title || "", row.gist].join(" ").toLowerCase().includes(words)));
		list.replaceChildren(...rows.map((row) => deckItem(row, close, draw)));
	};
	filter.addEventListener("input", draw);
	filter.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
	document.addEventListener("mousedown", outside);
	draw();
	box.append(pop);
	filter.focus();
}
`;
