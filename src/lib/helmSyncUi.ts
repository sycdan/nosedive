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
	// Built once, so its timer and listener outlive each redraw.
	root.live = liveStatus(() => root.isConnected);
	return drawBranch(root);
}

/** Fills the Branch view from a fresh read; does nothing once the pilot has left it. */
async function drawBranch(root) {
	const branch = bridge.branch || { name: "?", trunk: "main" };
	const head = [el("h3", {}, branch.name),
		el("p", { class: "rel" }, branch.ahead == null ? "no origin/" + branch.trunk + " to compare with"
			: "↑" + branch.ahead + " ↓" + branch.behind + " against origin/" + branch.trunk),
		syncButtons(root)];
	if (!root.childNodes.length) root.replaceChildren(...head, el("p", { class: "rel" }, "fetching…"), ...root.live);
	let info;
	try {
		info = await api("/api/sync/unpushed");
		showError(null);
	} catch (err) {
		if (root.isConnected) { showError(err); root.replaceChildren(...head, ...root.live); }
		return;
	}
	if (!root.isConnected) return;
	head[1].textContent = "↑" + info.ahead + " ↓" + info.behind + " against origin/" + info.trunk;
	const commits = el("ul", { class: "doclist" }, info.commits.length
		? info.commits.map((c) => el("li", {}, el("code", {}, c.hash), " ", c.subject, " ", el("span", { class: "rel" }, c.author + " · " + ago(c.at))))
		: [el("li", { class: "rel" }, "nothing ahead of origin/" + info.trunk)]);
	const parts = [...head, el("h4", {}, "Unpushed commits"), commits];
	if (info.commits.length >= 2) {
		const squash = info.blocker ? el("p", { class: "blocker" }, info.blocker)
			: el("button", { class: "act land", title: "Make these commits one", onclick: () => squashDialog(info, squash, root) }, "Squash");
		parts.push(el("div", { class: "squash" }, squash));
	}
	if (info.branch === info.trunk) {
		const list = el("div", { class: "branches" }, el("p", { class: "rel" }, "fetching…"));
		parts.push(el("h4", {}, "Branches"), list);
		root.replaceChildren(...parts, ...root.live);
		await drawBranches(root, list);
	} else root.replaceChildren(...parts, ...root.live);
}

function syncButtons(root) {
	const why = dives.active ? "Land, pack or bail the active dive first" : null;
	return el("div", { class: "syncacts" },
		el("button", { class: "act unstage", disabled: why ? "" : null, title: why || "Rebase this checkout onto its trunk", onclick: () => runSync("pull", root) }, "Pull"),
		el("button", { class: "act unstage", disabled: why ? "" : null, title: why || "Push this checkout to its trunk", onclick: () => confirmPush(root) }, "Push"));
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
