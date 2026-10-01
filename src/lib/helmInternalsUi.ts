/**
 * The Internals view, spliced into the page's script: the bridge config and
 * today's log, followed live while open. Also the poll line the Branch view
 * shows.
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
 * One live line counting down to helm's next check of the bridge, with when
 * it last saw a change; calls onChange for each change seen while open.
 */
function pollLine(isOpen, onChange) {
	const line = el("span", { class: "rel poll" });
	let lastChangeAt = null;
	const read = () => api("/api/internals").then((info) => {
		line.title = "Helm checks the bridge every " + info.pollEvery / 1000 + " s for a new dive or commit";
		lastChangeAt = info.lastChangeAt;
	}, () => {});
	const tick = () => {
		if (!isOpen()) return clearInterval(timer);
		const due = lastPoll ? lastPoll.at + lastPoll.every : null;
		line.textContent = (due == null ? "checking soon" : "next check " + (Math.max(0, due - Date.now()) / 1000).toFixed(1) + " s") +
			" · " + (lastChangeAt == null ? "no change yet" : "changed " + ago(lastChangeAt));
	};
	events.addEventListener("state", function seen() {
		if (!isOpen()) return events.removeEventListener("state", seen);
		read();
		onChange();
	});
	const timer = setInterval(tick, 150);
	read();
	tick();
	return line;
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
