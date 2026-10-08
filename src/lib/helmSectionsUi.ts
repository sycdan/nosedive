/**
 * Collapsible sections, a repo's page and the scope edits on it, spliced into
 * the page's script.
 */
export const helmSectionsScript = String.raw`
// --- sections and repo pages ------------------------------------------------

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

function fillRepoStatus(node, repo, status) {
	const h = status.hydrated;
	const n = status.nosedive;
	const facts = node.querySelector(".repo-status");
	if (repo.inScope) facts.replaceChildren(
		h ? fact(h.atTrunk ? "ok" : "warn", (h.atTrunk ? "at " : "off ") + repo.trunk, h.commit.slice(0, 8)) : fact("", "not hydrated"),
		n === "unknown" ? fact("", "nosedive ?") : n ? fact("ok", "nosedive", "L" + n.level) : fact("", "no nosedive"));
	else facts.replaceChildren(h ? fact("ok", "hydrated") : fact("", "not hydrated"));
	const actions = cardActions({ ...repo, ...status });
	node.querySelector(".repo-actions").replaceChildren(...(actions ? [actions] : []));
	const scope = scopeActions(repo);
	node.querySelector(".scope-actions").replaceChildren(...(scope ? [scope] : []));
}

/** A repo's page: its card -- status, hydrate and scope edits -- as the tree's context has it. */
async function repoPanel(id) {
	const context = treeContext || await api(contextQuery(ctx.root || (backlogRoot && backlogRoot.ref), false));
	const repo = context.repos.find((r) => r.id === id);
	if (!repo) return null;
	const card = repoCard(repo);
	card.dataset.repo = repo.id;
	api("/api/repo-statuses?ids=" + repo.id)
		.then((statuses) => { if (statuses[repo.id]) fillRepoStatus(card, repo, statuses[repo.id]); }, showError);
	return card;
}

// --- scope edits ------------------------------------------------------------

/** What a card's scope edit changes: the dive in context, else the deck. */
function scopeTarget() {
	const dive = diveInContext();
	if (dive) return { dive };
	return ctx.root ? { doc: ctx.root } : null;
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
	await refreshSections();
	const card = document.querySelector("#view .card[data-repo]");
	const next = card && await repoPanel(card.dataset.repo);
	if (next) card.replaceWith(next);
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
 * the deck: add, drop, or set the work branch -- a feat
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
	// Dropping the bridge off the backlog is crud's to refuse, in the notice.
	const drop = () => run("Drop scope", target.dive ? { verb: "unscope" } : { verb: "feat-scope", drop: true });
	box.append(target.dive
		? inlineForm(box, "Repin", field("ref to repin at", repo.scope.workBranch || repo.trunk),
			(ref) => run("Repin", { verb: "repin", ref }))
		: inlineForm(box, "Work branch", field("work branch", repo.scope.workBranch, "none"),
			(branch) => run("Work branch", { verb: "feat-scope", branch })),
		confirmButton("Drop scope", "pack", drop));
	return box;
}
`;
