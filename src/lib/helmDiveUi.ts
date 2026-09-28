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
	if (dives.active) {
		const reason = el("input", { type: "text", placeholder: "why bail?", class: "reason" });
		return bar.replaceChildren(el("span", { class: "state" }, "On dive"), title,
			el("span", { class: "gap" }),
			confirmButton("Land", "land", () => runVerb({ verb: "land" })),
			confirmButton("Pack", "pack", () => runVerb({ verb: "pack" })),
			reason,
			confirmButton("Bail", "bail", () => reason.value.trim()
				? runVerb({ verb: "bail", reason: reason.value.trim() })
				: reason.focus()));
	}
	bar.replaceChildren(el("span", { class: "state" }, "Staged"), title,
		el("span", { class: "gap" }),
		el("button", { class: "act unstage", onclick: () => stage(null) }, "Unstage"),
		confirmButton("Jump", "jump", () => runVerb({ verb: "jump", ref: dive.id })));
}

/** Staging touches nothing on disk: it narrows what the page shows to the dive's scopes. */
function stage(dive) {
	dives.staged = dive;
	renderBar();
	refreshGroups();
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
	refreshGroups();
}

function diveCard(dive) {
	return el("article", { class: "card" },
		el("div", { class: "name" }, el("button", { class: "linkish", onclick: () => select([{ id: dive.id, name: dive.title, kind: "dive" }]) }, dive.title)),
		el("div", { class: "gist" }, dive.gist),
		el("div", { class: "facts" },
			dive.feat ? fact("", "feat", dive.feat) : null,
			dive.repos.length ? fact("", "repos", dive.repos.join(", ")) : null,
			dive.diver ? fact("warn", "held by", dive.diver) : null),
		el("div", {}, el("button", { class: "act jump", onclick: () => stage(dive) }, "Stage")));
}

/** With no active dive, the empty page is for getting onto one. */
function divePicker() {
	const search = el("input", { type: "search", placeholder: "Find a dive" });
	const cards = el("div", { class: "cards" });
	const fill = async () => {
		const listing = await api("/api/dives?q=" + encodeURIComponent(search.value.trim()));
		cards.replaceChildren(...(listing.dives.length ? listing.dives.map(diveCard) : [el("p", { class: "empty" }, "No dives found.")]));
	};
	let timer;
	search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(fill, 200); });
	fill().catch(showError);
	const feat = el("input", { type: "text", placeholder: "feat (quid or name)", required: "" });
	const title = el("input", { type: "text", placeholder: "Title", required: "" });
	const gist = el("input", { type: "text", placeholder: "Gist", required: "" });
	const brief = el("textarea", { placeholder: "Brief", required: "", rows: "4" });
	const form = el("form", { class: "newdive" }, el("h3", {}, "New dive"), feat, title, gist, brief,
		el("button", { type: "submit" }, "Record dive"));
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		runVerb({ verb: "record.dive", feat: feat.value, title: title.value, gist: gist.value, brief: brief.value });
	});
	return el("section", { class: "picker" }, el("h3", {}, "Dives"), search, cards, form);
}
`;
