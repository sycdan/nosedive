/**
 * The Branches view, spliced into the page's script: on trunk, origin's other
 * branches with what each has over the local trunk, and a Merge that
 * fast-forwards the local trunk to one. Nothing is pushed.
 */
export const helmBranchesScript = String.raw`
// --- branches ---------------------------------------------------------------

/** The header's Branches button, shown only on trunk. */
function renderBranchesButton() {
	const branch = bridge.branch;
	const onTrunk = branch && branch.name === branch.trunk;
	document.getElementById("branchacts").replaceChildren(...(onTrunk
		? [el("button", { class: "act unstage", title: "Origin's branches, to merge into " + branch.trunk, onclick: showBranches }, "Branches")]
		: []));
}

async function showBranches() {
	reposOpen = false;
	highlight(null);
	crumbs([]);
	document.getElementById("crumbs").append(el("span", { class: "sep" }, "/"), el("button", { title: "Origin's branches" }, "Branches"));
	history.replaceState(null, "", location.pathname + location.search);
	const list = el("div", { class: "branches" }, el("p", { class: "rel" }, "fetching…"));
	const root = el("section", { class: "branchview" }, el("h3", {}, "Branches"), list);
	document.getElementById("view").replaceChildren(root);
	await drawBranches(root, list);
}

async function drawBranches(root, list) {
	let info;
	try {
		info = await api("/api/branches");
		showError(null);
	} catch (err) {
		if (root.isConnected) showError(err);
		return;
	}
	if (!root.isConnected) return;
	const trunk = info.trunk;
	list.replaceChildren(...(info.branches.length
		? info.branches.map((b) => branchCard(b, trunk, root, list))
		: [el("p", { class: "empty" }, "no remote branches besides " + trunk)]));
}

/** Why a branch cannot be merged now, and what to do about it; null when it can. */
function mergeBlocker(b, trunk) {
	if (b.ahead === 0) return "Nothing to merge: " + trunk + " already has every commit on this branch.";
	if (!b.mergeable) return "Can't merge yet: " + trunk + " has " + b.behind + " commit" + (b.behind === 1 ? "" : "s") +
		" this branch lacks. Pull in its helm (helm " + b.name + "), then reopen Branches.";
	if (dives.active) return "Can't merge during a dive: land, pack or bail it first.";
	return null;
}

function branchCard(b, trunk, root, list) {
	const why = mergeBlocker(b, trunk);
	const button = why ? el("p", { class: "blocker" }, why) : el("button", { class: "act land", title: "Fast-forward " + trunk + " to origin/" + b.name,
		onclick: () => confirmDialog({
			verb: "Merge", cls: "land", target: "origin/" + b.name + " into " + trunk,
			detail: "Fast-forwards the local " + trunk + " to origin/" + b.name + ". Nothing is pushed; use Push to publish.",
			act: () => runMerge(b.name, button, root, list),
		}) }, "Merge");
	const commits = el("ul", { class: "doclist" }, b.commits.length
		? b.commits.map((c) => el("li", {}, el("code", {}, c.hash), " ", c.subject, " ", el("span", { class: "rel" }, c.author + " · " + ago(c.at))))
		: [el("li", { class: "rel" }, "no commits")]);
	return el("article", { class: "card branchcard" },
		el("div", { class: "name" }, b.name, " ", el("code", {}, b.head)),
		el("div", { class: "facts" }, el("span", { class: "count", title: "ahead of / behind " + trunk }, "↑" + b.ahead + " ↓" + b.behind + " " + trunk)),
		commits,
		el("div", { class: "cardacts" }, button));
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
	if (root.isConnected) await drawBranches(root, list);
	await loadDecks();
}
`;
