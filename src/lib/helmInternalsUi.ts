/**
 * The Internals view, spliced into the page's script: the bridge config and
 * today's log, followed live while open. Also the poll line and recent
 * commits the Branch view shows.
 */
export const helmInternalsScript = String.raw`
// --- internals --------------------------------------------------------------

/** The last poll tick, so the view counts down from it; null until one arrives. */
let lastPoll = null;
/** Log text arrived since the view opened, handed to it as it comes. */
let onLogText = null;

events.addEventListener("poll", (event) => { lastPoll = JSON.parse(event.data); });
events.addEventListener("log", (event) => { if (onLogText) onLogText(JSON.parse(event.data)); });

function ago(ms) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	return s < 60 ? s + " s ago" : s < 3600 ? Math.floor(s / 60) + " min ago" : Math.floor(s / 3600) + " h ago";
}

/**
 * The poll line and recent commits, live while the view holding them is open;
 * the Branch view shows them. They fill in once their first read lands.
 */
function liveStatus(isOpen) {
	const next = el("span", {});
	const change = el("span", {});
	const every = el("span", {}, "Bridge checked");
	const commits = el("ul", { class: "doclist" }, el("li", { class: "rel" }, "reading…"));
	let lastChangeAt = null;
	const drawCommits = (list) => commits.replaceChildren(...(list.length ? list.map((c) => el("li", {},
		el("code", {}, c.hash), " ", c.subject, " ", el("span", { class: "rel" }, c.author + " · " + ago(c.at)),
		c.pushed === false ? el("span", { class: "count", title: "Not on the upstream yet" }, "unpushed") : null)) : [el("li", { class: "rel" }, "no commits")]));
	const read = () => api("/api/internals").then((info) => {
		every.textContent = "Bridge checked every " + info.pollEvery / 1000 + " s for a new dive or commit";
		lastChangeAt = info.lastChangeAt;
		drawCommits(info.commits || []);
	}, () => {});
	const tick = () => {
		if (!isOpen()) return clearInterval(timer);
		const due = lastPoll ? lastPoll.at + lastPoll.every : null;
		next.textContent = due == null ? "waiting for the first check" : "next check in " + (Math.max(0, due - Date.now()) / 1000).toFixed(1) + " s";
		change.textContent = lastChangeAt == null ? "no change since helm started" : "last change seen " + ago(lastChangeAt);
	};
	// A state change seen while open moves "last change seen" along and redraws the commits.
	events.addEventListener("state", function seen() {
		if (!isOpen()) return events.removeEventListener("state", seen);
		read();
	});
	const timer = setInterval(tick, 150);
	read();
	tick();
	return [el("h4", {}, "Poll"), el("p", {}, every, " · ", next, " · ", change), el("h4", {}, "Recent commits"), commits];
}

async function showInternals() {
	reposOpen = false;
	highlight(null);
	crumbs([]);
	document.getElementById("crumbs").append(el("span", { class: "sep" }, "/"), el("button", { title: "Helm internals" }, "Internals"));
	try {
		const info = await api("/api/internals");
		showError(null);
		const log = el("pre", { class: "output" }, info.log);
		const root = el("section", { class: "internals" },
			el("h3", {}, "Internals"),
			el("h4", {}, "Config"), el("p", {}, el("code", {}, info.configPath)),
			el("pre", { class: "output" }, info.config),
			el("h4", {}, "Log"), el("p", {}, el("code", {}, info.logPath)), log);
		// Pinned to the bottom unless the user has scrolled up.
		const append = (text) => {
			if (!root.isConnected) { if (onLogText === append) onLogText = null; return; }
			const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
			log.append(text);
			if (pinned) log.scrollTop = log.scrollHeight;
		};
		onLogText = append;
		document.getElementById("view").replaceChildren(root);
		log.scrollTop = log.scrollHeight;
	} catch (err) { showError(err); }
}

document.getElementById("helmbtn").addEventListener("click", showInternals);
`;
