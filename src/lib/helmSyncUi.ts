/**
 * The header's Pull and Push, spliced into the page's script: Pull rebases the
 * bridge checkout onto its trunk, Push asks first, then fast-forwards trunk and
 * updates the branch. Both wait while a dive is active.
 */
export const helmSyncScript = String.raw`
// --- sync -------------------------------------------------------------------

function renderSync() {
	const why = dives.active ? "Land, pack or bail the active dive first" : null;
	document.getElementById("syncacts").replaceChildren(
		el("button", { class: "act unstage", disabled: why ? "" : null, title: why || "Rebase this checkout onto its trunk", onclick: () => runSync("pull") }, "Pull"),
		el("button", { class: "act unstage", disabled: why ? "" : null, title: why || "Push this checkout to its trunk", onclick: confirmPush }, "Push"));
}

function confirmPush() {
	const branch = bridge.branch || { name: "?", trunk: "main" };
	const off = branch.name !== branch.trunk;
	confirmDialog({
		verb: "Push", cls: "land", target: "to origin/" + branch.name,
		detail: off
			? "Force-updates origin/" + branch.name + " to this checkout. origin/" + branch.trunk + " is never touched; merging into it is up to you."
			: "Fast-forwards origin/" + branch.trunk + " to this checkout for everyone, and never forces it.",
		act: () => runSync("push"),
	});
}

async function runSync(action) {
	const verb = action === "pull" ? "Pull" : "Push";
	const buttons = document.querySelectorAll("#syncacts button");
	for (const button of buttons) {
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
	renderSync();
	syncNotice(failed ? verb + " refused" : verb + "ed", text, failed);
	await loadDecks();
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
