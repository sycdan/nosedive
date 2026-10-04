/**
 * The page's dive bar and dive picker, spliced into its script. Every action
 * runs the real command through /api/run and streams its output.
 */
export const helmDiveScript = String.raw`
// --- dives ------------------------------------------------------------------

/** The active dive (the workspace's) and the staged one (this page's pick). */
const dives = { active: null, staged: null };

function diveInContext() {
	return dives.active ? dives.active.id : dives.staged ? dives.staged.id : null;
}

async function loadDives() {
	const listing = await api("/api/dives");
	dives.active = listing.active;
	if (dives.active) dives.staged = null;
	document.body.classList.toggle("diving", !!dives.active);
	await loadCreatable();
	renderBar();
	return listing;
}

/** A button that asks once before it acts. */
function confirmButton(label, cls, act) {
	const button = el("button", { class: "act " + cls }, label);
	let armed = false;
	button.addEventListener("click", () => {
		if (!armed) { armed = true; button.textContent = "Confirm " + label.toLowerCase() + "?"; return; }
		act();
	});
	button.addEventListener("blur", () => { armed = false; button.textContent = label; });
	return button;
}

function renderBar() {
	const bar = document.getElementById("divebar");
	const dive = dives.active || dives.staged;
	if (!dive) return bar.replaceChildren(el("span", { class: "state" }, "No dive"));
	const title = el("button", { class: "linkish", onclick: () => select([{ id: dive.id, name: dive.title, kind: "dive" }]) }, dive.title);
	if (dives.active)
		return bar.replaceChildren(el("span", { class: "state" }, "On dive"), title,
			el("span", { class: "gap" }),
			...createControl(),
			el("button", { class: "act land", onclick: () => confirmDialog({
				verb: "Land", cls: "land", target: dive.title,
				detail: "Pushes " + scopeList(dive) + (dive.repos.length === 1 ? " to its work branch" : " to their work branches") + ", closes the dive, and pushes the bridge.",
				act: () => runVerb({ verb: "land" }),
			}) }, "Land"),
			el("button", { class: "act pack", onclick: () => confirmDialog({
				verb: "Pack", cls: "pack", target: dive.title,
				detail: "Captures the work in " + scopeList(dive) + " as patches, pushes the bridge, releases the dive, and resets each worktree to its pin.",
				act: () => runVerb({ verb: "pack" }),
			}) }, "Pack"),
			el("button", { class: "act bail", onclick: () => confirmDialog({
				verb: "Bail", cls: "bail", target: dive.title,
				detail: "Closes the dive with your reason and resets its worktrees; its work is not kept.",
				reason: "Why bail?",
				act: (why) => runVerb({ verb: "bail", reason: why }),
			}) }, "Bail"));
	bar.replaceChildren(el("span", { class: "state" }, "Staged"), title,
		el("span", { class: "gap" }),
		el("button", { class: "act unstage", onclick: () => { stage(null); reset(); } }, "Unstage"),
		confirmButton("Jump", "jump", () => runVerb({ verb: "jump", ref: dive.id })));
}

/** In the header, not the dive bar: a note needs no dive. */
function noteButton() {
	return el("button", { class: "act unstage", onclick: noteDialog }, "Note");
}

/**
 * A note needs no dive: nosedive note writes to the bridge directly. The
 * first line is its gist -- a leading <kind>: sets its kind -- and the rest
 * its body. The result shows in the modal, so the page underneath stays put.
 */
function noteDialog() {
	const text = el("textarea", { rows: "4", placeholder: "todo: take over the world", "aria-label": "note" });
	// The picked root's repos it is about: nosedive note scopes the note to them and links it from each.
	const repos = el("fieldset", { class: "repos", hidden: "" }, el("legend", {}, "about"));
	api("/api/repos" + (ctx.root ? "?root=" + ctx.root : "")).then((list) => {
		repos.append(...list.map((repo) => el("label", { class: "toggle" },
			el("span", {}, repo.name), el("input", { type: "checkbox", role: "switch", value: repo.id }))));
		repos.hidden = !list.length;
	}, showError);
	const out = el("pre", { class: "output", hidden: "" });
	const save = el("button", { type: "submit", class: "act jump" }, "Save note");
	const form = el("form", {}, el("h3", {}, "Note"), text, repos, out,
		el("div", { class: "modalacts" },
			el("button", { type: "button", class: "act unstage", onclick: () => dialog.close() }, "Close"), save));
	const dialog = el("dialog", { class: "modal" }, form);
	dialog.addEventListener("close", () => dialog.remove());
	dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (!text.value.trim()) return text.focus();
		save.disabled = true;
		try {
			const res = await fetch("/api/run", {
				method: "POST",
				headers: { "x-helm-token": token, "content-type": "application/json" },
				body: JSON.stringify({ verb: "note", text: text.value,
					scopes: [...repos.querySelectorAll("input:checked")].map((box) => box.value) }),
			});
			out.textContent = res.ok ? await res.text() : (await res.json()).error;
		} catch (err) {
			out.textContent = String(err.message || err);
		}
		const ok = /\[exit 0\]\s*$/.test(out.textContent);
		out.hidden = false;
		out.classList.toggle("failed", !ok);
		if (ok) { text.value = ""; refreshSections(); }
		save.disabled = false;
	});
	document.body.append(dialog);
	dialog.showModal();
	text.focus();
}

function scopeList(dive) {
	return dive.repos.length ? dive.repos.join(", ") : "its scopes";
}

/**
 * A costly action asks in a modal: "<Verb> <target>?", what it does, then
 * Cancel and "Confirm <verb>". Focus starts on Cancel -- or on the reason, when
 * one is asked for -- so a stray Enter or a double-click backs out; Esc or a
 * click outside closes it too.
 */
function confirmDialog({ verb, cls, target, detail, reason, act }) {
	const why = reason ? el("input", { type: "text", placeholder: reason, "aria-label": "reason" }) : null;
	const cancel = el("button", { type: "button", class: "act unstage", onclick: () => dialog.close() }, "Cancel");
	const form = el("form", {}, el("h3", {}, verb + " " + target + "?"), el("p", { class: "detail" }, detail), why,
		el("div", { class: "modalacts" }, cancel,
			el("button", { type: "submit", class: "act " + cls }, "Confirm " + verb.toLowerCase())));
	const dialog = el("dialog", { class: "modal" }, form);
	dialog.addEventListener("close", () => dialog.remove());
	dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const given = why ? why.value.trim() : "";
		if (why && !given) return why.focus();
		dialog.close();
		act(given);
	});
	document.body.append(dialog);
	dialog.showModal();
	(why || cancel).focus();
}

/** Staging touches nothing on disk: it narrows what the page shows to the dive's scopes. */
function stage(dive) {
	dives.staged = dive;
	renderBar();
	refreshSections();
}

/** Runs a dive verb and shows its output as it streams in. */
async function runVerb(body) {
	const out = el("pre", { class: "output streaming" }, "");
	document.getElementById("view").replaceChildren(el("h3", {}, "nosedive " + body.verb), out);
	try {
		const res = await fetch("/api/run", {
			method: "POST",
			headers: { "x-helm-token": token, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error((await res.json()).error || res.statusText);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			out.textContent += decoder.decode(value);
			out.scrollTop = out.scrollHeight;
		}
		out.classList.toggle("failed", !/\[exit 0\]\s*$/.test(out.textContent));
	} catch (err) {
		out.textContent += String(err.message || err);
		out.classList.add("failed");
	}
	out.classList.remove("streaming");
	await loadDives();
	// A land can add a root to the bridge, so the tree re-reads them too.
	await loadRoots();
	refreshSections();
}

/** Clicking a dive's card opens its doc, which stages it. */
function diveCard(dive) {
	return el("article", { class: "card pick", tabindex: "0", onclick: () => select([{ id: dive.id, name: dive.title, kind: "dive" }]) },
		el("div", { class: "name" }, dive.title),
		el("div", { class: "gist" }, dive.gist),
		el("div", { class: "facts" },
			dive.feat ? fact("", "feat", dive.feat) : null,
			dive.repos.length ? fact("", "repos", dive.repos.join(", ")) : null,
			dive.diver ? fact("warn", "held by", dive.diver) : null));
}

/** A feat is a feat doc, or any doc a root links as <type>.feat. */
function isFeatStep(step) {
	return step.kind === "feat" || /(^|\.)feat$/.test(step.rel || "");
}

/**
 * With no dive active, a feat lists the dives it reaches, and one with none
 * can be jumped straight into: jump records the dive. On a dive, it can have
 * a dive planned on it, through crud dive.
 */
function featActions(doc, step) {
	if (!isFeatStep(step)) return null;
	return dives.active ? planForm(doc) : divePicker(doc);
}

function planForm(doc) {
	const title = el("input", { type: "text", placeholder: "Title" });
	const gist = el("input", { type: "text", placeholder: "Gist", required: "" });
	const brief = el("textarea", { placeholder: "Brief", required: "", rows: "4" });
	let out = outputBox("");
	const show = (text, failed) => { const next = outputBox(text, failed); out.replaceWith(next); out = next; };
	const form = el("form", { class: "newdive" }, el("h3", {}, "Plan a dive"), title, gist, brief,
		el("button", { type: "submit" }, "Plan dive"), out);
	onSubmit(form, async () => {
		try {
			const run = await write("/api/crud/dive", { feat: doc.ref, title: title.value || undefined, gist: gist.value, brief: brief.value });
			show(run.stdout);
			form.reset();
		} catch (err) {
			show(String(err.message || err), true);
		}
	});
	return form;
}

function jumpInto(doc) {
	return confirmButton("Jump " + (doc.title || display(doc)), "jump", () => runVerb({ verb: "jump", ref: doc.ref }));
}

/**
 * Opening a dive's doc with no dive active stages it: the dive bar names it
 * and offers Jump, and the tree narrows to its scopes until it is unstaged.
 */
function stageOpened(doc) {
	if (doc.kind !== "dive" || dives.active || (dives.staged && dives.staged.id === doc.id)) return;
	stage({ id: doc.id, title: label(doc), gist: doc.gist, repos: [] });
}

/**
 * With no active dive, the page is for getting onto one: the dives the picked
 * root reaches, or -- given a feat -- the ones that feat reaches, which, when
 * it has none, can be jumped straight into if jump would take it.
 */
function divePicker(feat) {
	const search = el("input", { type: "search", placeholder: "Find a dive" });
	const cards = el("div", { class: "cards" });
	const fill = async () => {
		const params = new URLSearchParams({ q: search.value.trim() });
		if (ctx.root) params.set("root", ctx.root);
		if (feat) params.set("feat", feat.id);
		const listing = await api("/api/dives?" + params);
		const none = feat && !search.value.trim()
			? [el("div", { class: "nodives" }, el("p", { class: "empty" }, "No dives planned on this feat."),
				feat.jumpable
					? el("div", { class: "cardacts" }, jumpInto(feat))
					: el("p", { class: "empty" }, "Nothing reaches it from the root through a .feat link; link it from a feat to jump it."))]
			: [el("p", { class: "empty" }, "No dives found.")];
		cards.replaceChildren(...(listing.dives.length ? listing.dives.map(diveCard) : none));
	};
	let timer;
	search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(fill, 200); });
	fill().catch(showError);
	return el("section", { class: "picker" }, el("h3", {}, "Dives"), search, cards);
}
`;
