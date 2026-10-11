/**
 * The Branch view's Branches section, spliced into the page's script:
 * origin's other branches with what each has over the local trunk. On trunk,
 * Merge fast-forwards the local trunk and Delete removes a remote branch.
 */
export const helmBranchesScript = String.raw`
// --- branches ---------------------------------------------------------------

const BRANCH_FETCH_EVERY = 60000;

function branchesCard(root) {
	const list = el("div", { class: "branches" }, el("p", { class: "rel" }, "fetching…"));
	const checked = el("span", { class: "rel" }, "not checked yet");
	const error = el("p", { class: "blocker", hidden: "" });
	const refresh = el("button", { class: "act unstage", title: "Refresh branches from origin", "aria-label": "Refresh branches", onclick: () => drawBranches(root) }, "↻");
	const state = { list, checked, error, refresh, busy: false, signature: null, checkedAt: null };
	root.branches = state;
	state.card = syncCard("Branches", [checked, refresh], error, list);
	let nextFetch = Date.now() + BRANCH_FETCH_EVERY;
	const timer = setInterval(() => {
		if (!root.isConnected) return clearInterval(timer);
		if (state.checkedAt != null) checked.textContent = "checked " + Math.floor((Date.now() - state.checkedAt) / 1000) + "s ago";
		if (Date.now() >= nextFetch) {
			nextFetch = Date.now() + BRANCH_FETCH_EVERY;
			if (bridge.branch && bridge.branch.name === bridge.branch.trunk) drawBranches(root);
		}
	}, 1000);
	return state.card;
}

async function drawBranches(root) {
	const state = root.branches;
	if (!state || state.busy || !root.isConnected) return;
	state.busy = true;
	state.refresh.disabled = true;
	try {
		const info = await api("/api/branches");
		if (!root.isConnected) return;
		state.checkedAt = Date.now();
		state.checked.textContent = "checked 0s ago";
		state.error.hidden = true;
		const signature = JSON.stringify([info, !!dives.active]);
		if (signature === state.signature) return;
		state.signature = signature;
		state.list.replaceChildren(...(info.branches.length
			? info.branches.map((b) => branchCard(b, info.trunk, root, state.list, info.onTrunk))
			: [el("p", { class: "empty" }, "no remote branches besides " + info.trunk)]));
	} catch (err) {
		if (root.isConnected) {
			state.error.textContent = "Branch fetch failed: " + String(err.message || err);
			state.error.hidden = false;
		}
	} finally {
		state.busy = false;
		state.refresh.disabled = false;
	}
}

/** Why a branch cannot be merged now, and what to do about it; null when it can. */
function mergeBlocker(b, trunk) {
	if (b.ahead === 0) return "Nothing to merge: " + trunk + " already has every commit on this branch.";
	if (!b.mergeable) return "Can't merge yet: " + trunk + " has " + b.behind + " commit" + (b.behind === 1 ? "" : "s") +
		" this branch lacks. Pull in its helm (helm " + b.name + "), then reopen the Branch view.";
	if (dives.active) return "Can't merge during a dive: land, pack or bail it first.";
	return null;
}

function branchCard(b, trunk, root, list, onTrunk) {
	const why = mergeBlocker(b, trunk);
	const button = why ? el("p", { class: "blocker" }, why) : el("button", { class: "act land", title: "Fast-forward " + trunk + " to origin/" + b.name,
		onclick: () => confirmDialog({
			verb: "Merge", cls: "land", target: "origin/" + b.name + " into " + trunk,
			detail: "Fast-forwards the local " + trunk + " to origin/" + b.name + ". Nothing is pushed; use Push to publish.",
			act: () => runMerge(b.name, button, root, list),
		}) }, "Merge");
	const remove = el("button", { class: "act bail", onclick: () => confirmDialog({
		verb: "Delete", cls: "bail", target: b.name + " from origin",
		detail: "Deletes origin/" + b.name + " and removes its clean helm worktree. Dirty worktrees are kept." +
			(b.ahead > 0 ? " " + b.ahead + " commit" + (b.ahead === 1 ? "" : "s") + " that " + trunk + " lacks will be lost from origin." : ""),
		requiredText: b.ahead > 0 ? b.name : null,
		act: () => runDeleteBranch(b.name, remove, root),
	}) }, "Delete");
	const commits = el("ul", { class: "doclist" }, b.commits.length
		? b.commits.map((c) => el("li", {}, el("code", {}, c.hash), " ", c.subject, " ", el("span", { class: "rel" }, c.author + " · " + ago(c.at))))
		: [el("li", { class: "rel" }, "no commits")]);
	return el("article", { class: "card branchcard" },
		el("div", { class: "name" }, b.name, " ", el("code", {}, b.head)),
		el("div", { class: "facts" }, el("span", { class: "count", title: "ahead of / behind " + trunk }, "↑" + b.ahead + " ↓" + b.behind + " " + trunk)),
		commits,
		onTrunk ? el("div", { class: "cardacts" }, button, remove) : null);
}

async function runDeleteBranch(name, button, root) {
	button.disabled = true;
	button.textContent = "Deleting…";
	let text;
	let failed = false;
	try { text = (await write("/api/branches/delete", { branch: name })).output || "branch deleted"; }
	catch (err) { text = String(err.message || err); failed = true; }
	syncNotice(failed ? "Delete refused" : "Deleted", text, failed);
	if (root.isConnected) await drawBranch(root);
}

async function runMerge(name, button, root, list) {
	button.disabled = true;
	button.textContent = "Merging…";
	let text = "";
	let failed = false;
	try {
		text = (await write("/api/branches/merge", { branch: name })).output || "merge done";
	} catch (err) {
		text = String(err.message || err);
		failed = true;
	}
	syncNotice(failed ? "Merge refused" : "Merged", text, failed);
	await loadRoots();
	if (root.isConnected) await drawBranch(root);
}
`;
