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
 * another ref is typed), drop, or add. With none, on the picked feat or the
 * backlog: add, drop, or set the work branch -- a feat scope has no pin.
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
			(branch) => run("Add scope", { verb: target.dive ? "upscope" : "feat-scope", branch })));
		return box;
	}
	box.append(target.dive
		? inlineForm(box, "Repin", field("ref to repin at", repo.scope.workBranch || repo.trunk),
			(ref) => run("Repin", { verb: "repin", ref }))
		: inlineForm(box, "Work branch", field("work branch", repo.scope.workBranch, "none"),
			(branch) => run("Work branch", { verb: "feat-scope", branch })),
		confirmButton("Drop scope", "pack", () => run("Drop scope", target.dive ? { verb: "unscope" } : { verb: "feat-scope", drop: true })));
	return box;
}
`;
