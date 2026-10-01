/**
 * The Branch view behind the header's branch pill, spliced into the page's
 * script: Pull rebases the bridge checkout onto its trunk, Push asks first,
 * then fast-forwards trunk or updates the branch, and Squash makes the
 * commits over trunk one. All wait while a dive is active. On trunk, the
 * view also lists origin's branches to merge.
 */
export const helmSyncScript = String.raw`
// --- branch view ------------------------------------------------------------

function showBranch() {
	reposOpen = false;
	highlight(null);
	crumbs([]);
	document.getElementById("crumbs").append(el("span", { class: "sep" }, "/"), el("button", { title: "The checked-out branch" }, "Branch"));
	history.replaceState(null, "", location.pathname + location.search);
	const root = el("section", { class: "branchview" });
	document.getElementById("view").replaceChildren(root);
	// Built once, so its timer and listener outlive each redraw; a change it sees redraws the view.
	root.poll = pollLine(() => root.isConnected, () => drawBranch(root));
	return drawBranch(root);
}

function commitList(commits, empty, mark) {
	return el("ul", { class: "doclist" }, commits.length
		? commits.map((c) => el("li", {}, el("code", {}, c.hash), " ", c.subject, " ", el("span", { class: "rel" }, c.author + " · " + ago(c.at)), mark ? mark(c) : null))
		: [el("li", { class: "rel" }, empty)]);
}

/** A card: a title and its actions on one row, then what it holds. */
function syncCard(title, actions, ...body) {
	return el("article", { class: "card synccard" },
		el("div", { class: "cardhead" }, el("h4", {}, title), el("div", { class: "syncacts" }, ...actions)), ...body);
}

/** Fills the Branch view from a fresh read; does nothing once the pilot has left it. */
async function drawBranch(root) {
	const branch = bridge.branch || { name: "?", trunk: "main" };
	if (!root.childNodes.length) root.replaceChildren(el("h3", {}, branch.name), el("p", { class: "rel" }, "fetching…"));
	let info;
	try {
		info = await api("/api/sync/unpushed");
		showError(null);
	} catch (err) {
		if (root.isConnected) showError(err);
		return;
	}
	if (!root.isConnected) return;
	const why = dives.active ? "Land, pack or bail the active dive first" : null;
	const off = info.branch !== info.trunk;
	const pull = syncCard("Pull · " + info.incoming.length + " from origin/" + info.trunk,
		[el("button", { class: "act unstage", disabled: why ? "" : null, title: why || "Rebase this checkout onto origin/" + info.trunk, onclick: () => runSync("pull", root) }, "Pull")],
		commitList(info.incoming, "up to date with origin/" + info.trunk));
	const squash = info.commits.length < 2 ? null : info.blocker ? el("p", { class: "blocker" }, info.blocker)
		: el("button", { class: "act unstage", title: "Make these commits one", onclick: () => squashDialog(info, squash, root) }, "Squash");
	const fresh = info.commits.filter((c) => c.pushed !== true).length;
	const push = syncCard("Push → origin/" + info.branch + " · " + (fresh ? fresh + " new" : off && info.replaces ? "rewritten" : "up to date"),
		[squash && squash.tagName === "BUTTON" ? squash : null,
			el("button", { class: "act unstage", disabled: why ? "" : null, title: why || "Push to origin/" + info.branch, onclick: () => confirmPush(root) }, "Push")],
		commitList(info.commits, "nothing ahead of origin/" + info.trunk,
			(c) => c.pushed === false ? el("span", { class: "count", title: "Not on origin/" + info.branch + " yet" }, "unpushed") : null),
		off && info.replaces ? el("p", { class: "blocker" }, "Pull or Squash rewrote " + info.replaces + " commit" + (info.replaces === 1 ? "" : "s") + " already on origin/" + info.branch + "; Push overwrites the old cop" + (info.replaces === 1 ? "y." : "ies.")) : null,
		squash && squash.tagName !== "BUTTON" ? squash : null);
	const history = syncCard("History", [root.poll], commitList(info.history, "no shared history"));
	const parts = [el("h3", {}, info.branch), pull, push, history];
	if (!off) {
		const list = el("div", { class: "branches" }, el("p", { class: "rel" }, "fetching…"));
		parts.push(syncCard("Branches", [], list));
		root.replaceChildren(...parts);
		await drawBranches(root, list);
	} else root.replaceChildren(...parts);
}

function confirmPush(root) {
	const branch = bridge.branch || { name: "?", trunk: "main" };
	const off = branch.name !== branch.trunk;
	confirmDialog({
		verb: "Push", cls: "land", target: "to origin/" + branch.name,
		detail: off
			? "Force-updates origin/" + branch.name + " to this checkout. origin/" + branch.trunk + " is never touched; merging into it is up to you."
			: "Fast-forwards origin/" + branch.trunk + " to this checkout for everyone, and never forces it.",
		act: () => runSync("push", root),
	});
}

async function runSync(action, root) {
	const verb = action === "pull" ? "Pull" : "Push";
	for (const button of root.querySelectorAll(".syncacts button")) {
		button.disabled = true;
		if (button.textContent === verb) button.textContent = action === "pull" ? "Pulling…" : "Pushing…";
	}
	let text = "";
	let failed = false;
	try {
		text = (await write("/api/sync/" + action, {})).output || action + " done";
	} catch (err) {
		text = String(err.message || err);
		failed = true;
	}
	syncNotice(failed ? verb + " refused" : verb + "ed", text, failed);
	await loadDecks();
	if (root.isConnected) await drawBranch(root);
}

/** Squash's confirm: the message to commit, prefilled from the commits it folds. */
function squashDialog(info, button, root) {
	const oldest = info.commits.slice().reverse();
	const text = el("textarea", { class: "squashmsg", "aria-label": "commit message" });
	text.value = info.commits[0].subject + "\n\nSquashes:\n" + oldest.map((c) => "- " + c.subject).join("\n");
	const cancel = el("button", { type: "button", class: "act unstage", onclick: () => dialog.close() }, "Cancel");
	const form = el("form", {}, el("h3", {}, "Squash " + info.commits.length + " commits into one?"),
		el("p", { class: "detail" }, "Makes the commits ahead of origin/" + info.trunk + " one commit with this message. Nothing is pushed; use Push to publish."),
		text,
		el("div", { class: "modalacts" }, cancel, el("button", { type: "submit", class: "act land" }, "Confirm squash")));
	const dialog = el("dialog", { class: "modal wide" }, form);
	dialog.addEventListener("close", () => dialog.remove());
	dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!text.value.trim()) return text.focus();
		const message = text.value;
		dialog.close();
		runSquash(message, button, root);
	});
	document.body.append(dialog);
	dialog.showModal();
	text.focus();
	text.setSelectionRange(0, 0);
	text.scrollTop = 0;
}

async function runSquash(message, button, root) {
	button.disabled = true;
	button.textContent = "Squashing…";
	let text = "";
	let failed = false;
	try {
		text = (await write("/api/sync/squash", { message })).output || "squash done";
	} catch (err) {
		text = String(err.message || err);
		failed = true;
	}
	syncNotice(failed ? "Squash refused" : "Squashed", text, failed);
	await loadDecks();
	if (root.isConnected) await drawBranch(root);
}

/** The corner notice: replaces any before it; success fades after 5 s unless opened, failure waits for ×. */
function syncNotice(title, text, failed) {
	const old = document.getElementById("syncnotice");
	if (old) old.remove();
	const pre = el("pre", { hidden: "" }, text);
	const toggle = el("button", { class: "linkish", "aria-expanded": "false", onclick: () => {
		pre.hidden = !pre.hidden;
		toggle.setAttribute("aria-expanded", String(!pre.hidden));
	} }, "details");
	const notice = el("div", { id: "syncnotice", class: failed ? "failed" : null, role: failed ? "alert" : "status" },
		el("div", { class: "head" }, el("strong", {}, title), toggle,
			el("button", { class: "close", title: "Dismiss", "aria-label": "Dismiss", onclick: () => notice.remove() }, "×")),
		pre);
	document.body.append(notice);
	if (!failed) setTimeout(() => { if (pre.hidden) notice.remove(); }, 5000);
}
`;
