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
		verb: "Push", cls: "land", target: branch.name,
		detail: "Fast-forwards origin/" + branch.trunk + " to this checkout for everyone, and never forces it." +
			(off ? " Then force-updates origin/" + branch.name + " to match." : ""),
		act: () => runSync("push"),
	});
}

async function runSync(action) {
	let text = "";
	let failed = false;
	try {
		text = (await write("/api/sync/" + action, {})).output || action + " done";
	} catch (err) {
		text = String(err.message || err);
		failed = true;
	}
	document.getElementById("view").replaceChildren(el("h3", {}, action === "pull" ? "Pull" : "Push"), outputBox(text, failed));
	await loadDecks();
}
`;
