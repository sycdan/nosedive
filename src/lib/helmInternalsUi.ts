/**
 * The Internals view, spliced into the page's script: the bridge config, a
 * countdown to helm's next poll, and today's log, followed live while open.
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

async function showInternals() {
	reposOpen = false;
	highlight(null);
	crumbs([]);
	document.getElementById("crumbs").append(el("span", { class: "sep" }, "/"), el("button", { title: "Helm internals" }, "Internals"));
	try {
		const info = await api("/api/internals");
		showError(null);
		const next = el("span", {});
		const change = el("span", {});
		const log = el("pre", { class: "output" }, info.log);
		const commits = el("ul", { class: "doclist" });
		const drawCommits = (list) => commits.replaceChildren(...(list.length ? list.map((c) => el("li", {},
			el("code", {}, c.hash), " ", c.subject, " ", el("span", { class: "rel" }, c.author + " · " + ago(c.at)),
			c.pushed === false ? el("span", { class: "count", title: "Not on the upstream yet" }, "unpushed") : null)) : [el("li", { class: "rel" }, "no commits")]));
		drawCommits(info.commits || []);
		const root = el("section", { class: "internals" },
			el("h3", {}, "Internals"),
			el("h4", {}, "Config"), el("p", {}, el("code", {}, info.configPath)),
			el("pre", { class: "output" }, info.config),
			el("h4", {}, "Poll"), el("p", {}, "Bridge checked every " + info.pollEvery / 1000 + " s for a new dive or commit · ", next, " · ", change),
			el("h4", {}, "Commits"), commits,
			el("h4", {}, "Log"), el("p", {}, el("code", {}, info.logPath)), log);
		const tick = () => {
			if (!root.isConnected) { clearInterval(timer); if (onLogText === append) onLogText = null; return; }
			const due = lastPoll ? lastPoll.at + lastPoll.every : null;
			next.textContent = due == null ? "waiting for the first check" : "next check in " + (Math.max(0, due - Date.now()) / 1000).toFixed(1) + " s";
			change.textContent = info.lastChangeAt == null ? "no change since helm started" : "last change seen " + ago(info.lastChangeAt);
		};
		// Pinned to the bottom unless the user has scrolled up.
		const append = (text) => {
			if (!root.isConnected) { if (onLogText === append) onLogText = null; return; }
			const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
			log.append(text);
			if (pinned) log.scrollTop = log.scrollHeight;
		};
		// A state change seen while open moves "last change seen" along and redraws the commits.
		events.addEventListener("state", function seen() {
			if (!root.isConnected) return events.removeEventListener("state", seen);
			api("/api/internals").then((fresh) => { info.lastChangeAt = fresh.lastChangeAt; drawCommits(fresh.commits || []); }, () => {});
		});
		onLogText = append;
		const timer = setInterval(tick, 150);
		document.getElementById("view").replaceChildren(root);
		tick();
		log.scrollTop = log.scrollHeight;
	} catch (err) { showError(err); }
}

document.getElementById("helmbtn").addEventListener("click", showInternals);
`;
