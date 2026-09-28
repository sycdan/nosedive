/**
 * The page's write controls, spliced into its script: every one posts to a
 * helm endpoint that runs `nosedive crud`, and shows crud's output or refusal.
 */
export const helmEditScript = String.raw`
// --- writes -----------------------------------------------------------------

async function write(path, body) {
	const res = await fetch(path, {
		method: "POST",
		headers: { "x-helm-token": token, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const out = await res.json();
	if (!res.ok) throw new Error(out.error || res.statusText);
	return out;
}

function outputBox(text, failed) {
	return el("pre", { class: "output" + (failed ? " failed" : ""), hidden: text ? null : "" }, text || "");
}

/** Runs a write from a form, keeping the form still until crud answers. */
function onSubmit(form, run) {
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		form.inert = true;
		try { await run(); } finally { form.inert = false; }
	});
}

/** The + form over a kind's doc list: crud --repo <repo> <kind> [--name] <gist>. */
function mintForm(kind, rerender) {
	const reach = kind.inCrudContext;
	const gist = el("input", { type: "text", placeholder: "Gist of a new " + kind.name, required: "", disabled: reach ? null : "" });
	const name = el("input", { type: "text", placeholder: "name (optional)", disabled: reach ? null : "" });
	const form = el("form", { class: "make", title: reach ? null : OUT_OF_REACH },
		gist, name, el("button", { type: "submit", disabled: reach ? null : "" }, "+ " + kind.name));
	onSubmit(form, async () => {
		try {
			const run = await write("/api/crud/mint", { repo: kind.repoId, kind: kind.name, gist: gist.value, name: name.value || undefined });
			refreshGroups();
			rerender(outputBox(run.stdout));
		} catch (err) {
			rerender(outputBox(String(err.message || err), true));
		}
	});
	return form;
}

function fieldFor(key, spec, value) {
	const shown = value == null ? "" : String(value);
	let input;
	if (Array.isArray(spec.enum)) {
		input = el("select", { name: key }, el("option", { value: "" }, "—"),
			spec.enum.map((option) => el("option", { value: String(option) }, String(option))));
		input.value = shown;
	} else if (spec.type === "number" || spec.type === "integer") {
		input = el("input", { type: "number", name: key, min: spec.minimum, max: spec.maximum, step: spec.type === "integer" ? "1" : "any" });
		input.value = shown;
	} else if (spec.type === "boolean") {
		input = el("input", { type: "checkbox", name: key });
		input.checked = value === true;
	} else if (spec.type === "string" || spec.type === undefined) {
		input = el("input", { type: "text", name: key, pattern: spec.pattern, minlength: spec.minLength, maxlength: spec.maxLength });
		input.value = shown;
	} else {
		input = el("input", { type: "text", name: key, disabled: "", title: "a " + spec.type + " is edited with crud <quid> --meta -" });
		input.value = JSON.stringify(value == null ? null : value);
	}
	input.dataset.kind = Array.isArray(spec.enum) ? "enum" : spec.type || "string";
	return input;
}

/** What changed in the form, as a crud --meta patch: a cleared field removes its key. */
function patchFrom(inputs, meta) {
	const patch = {};
	for (const input of inputs) {
		if (input.disabled) continue;
		const key = input.name;
		const had = meta[key];
		let next;
		if (input.dataset.kind === "boolean") next = input.checked;
		else if (input.value === "") next = null;
		else if (input.dataset.kind === "number" || input.dataset.kind === "integer") next = Number(input.value);
		else next = input.value;
		if (next === null ? had != null : next !== had) patch[key] = next;
	}
	return patch;
}

/** A doc's meta as a form generated from its kind's schema; saving runs crud <quid> --meta -. */
function metaForm(doc, repoId, schema, reach, rerender) {
	const properties = (schema && schema.properties) || {};
	const required = (schema && schema.required) || [];
	const meta = doc.meta || {};
	const inputs = Object.entries(properties).map(([key, spec]) => fieldFor(key, spec || {}, meta[key]));
	if (!inputs.length) return null;
	const rows = inputs.map((input) => el("label", { class: "field" },
		el("span", {}, input.name + (required.includes(input.name) ? " *" : "")), input));
	const form = el("form", { class: "meta", title: reach ? null : OUT_OF_REACH },
		el("fieldset", { disabled: reach ? null : "" }, el("legend", {}, "meta"), rows,
			el("button", { type: "submit" }, "Save meta")));
	onSubmit(form, async () => {
		const patch = patchFrom(inputs, meta);
		if (!Object.keys(patch).length) return rerender(outputBox("Nothing changed."));
		try {
			const run = await write("/api/crud/meta", { id: doc.id, repo: repoId, patch });
			refreshGroups();
			rerender(outputBox(run.stdout));
		} catch (err) {
			rerender(outputBox(String(err.message || err), true));
		}
	});
	return form;
}

/** The empty page's New deck form: crud deck [--name] <gist>. */
function deckForm() {
	const gist = el("input", { type: "text", placeholder: "New deck", required: "" });
	const name = el("input", { type: "text", placeholder: "name (optional)" });
	const out = outputBox();
	const form = el("form", { class: "make" }, gist, name, el("button", { type: "submit" }, "Make deck"));
	onSubmit(form, async () => {
		try {
			const run = await write("/api/crud/deck", { gist: gist.value, name: name.value || undefined });
			const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(run.stdout);
			await loadDecks();
			if (id) select([{ id: id[1], name: name.value || gist.value, kind: "deck" }]);
		} catch (err) {
			out.replaceWith(outputBox(String(err.message || err), true));
		}
	});
	return [form, out];
}
`;
