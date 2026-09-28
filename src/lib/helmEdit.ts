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

/** The empty page's New deck form: crud deck --name <name> [<gist>]; helm stamps a gist left empty. */
function deckForm() {
	const name = el("input", { type: "text", placeholder: "New deck name", required: "" });
	const gist = el("input", { type: "text", placeholder: "What's the deck for?" });
	const out = outputBox();
	const form = el("form", { class: "make" }, name, gist, el("button", { type: "submit" }, "Make deck"));
	onSubmit(form, async () => {
		try {
			const run = await write("/api/crud/deck", { name: name.value, gist: gist.value || undefined });
			const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(run.stdout);
			await loadDecks();
			if (id) select([{ id: id[1], name: name.value, kind: "deck" }]);
		} catch (err) {
			out.replaceWith(outputBox(String(err.message || err), true));
		}
	});
	return [form, out];
}

/** Hydrate (a ref, prefilled with trunk) or dehydrate (confirmed once) a repo from its card. */
function cardActions(repo) {
	if (repo.isBridge) return null;
	if (repo.hydrated)
		return el("div", { class: "cardacts" },
			confirmButton("Dehydrate", "pack", () => runVerb({ verb: "dehydrate", repo: repo.id })));
	const box = el("div", { class: "cardacts" });
	const open = el("button", { class: "act jump" }, "Hydrate");
	open.addEventListener("click", () => {
		const ref = el("input", { type: "text", value: repo.trunk, "aria-label": "ref to hydrate at" });
		const form = el("form", { class: "make" }, ref, el("button", { type: "submit" }, "Hydrate"));
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			runVerb({ verb: "hydrate", repo: repo.id, at: ref.value.trim() });
		});
		box.replaceChildren(form);
		ref.select();
	});
	box.append(open);
	return box;
}

// --- kind schema ------------------------------------------------------------

const FIELD_TYPES = ["string", "number", "integer", "boolean"];

function schemaRow(name, spec, required, rows) {
	const input = (attrs, value) => { const node = el("input", attrs); node.value = value == null ? "" : String(value); return node; };
	const key = input({ type: "text", placeholder: "field", "aria-label": "field name" }, name);
	const type = el("select", { "aria-label": "type" }, FIELD_TYPES.map((t) => el("option", { value: t }, t)));
	type.value = FIELD_TYPES.includes(spec.type) ? spec.type : "string";
	const must = el("input", { type: "checkbox", "aria-label": "required" });
	must.checked = required;
	const choices = input({ type: "text", placeholder: "enum: a, b", "aria-label": "allowed values" }, (spec.enum || []).join(", "));
	const min = input({ type: "number", placeholder: "min", "aria-label": "minimum" }, spec.minimum);
	const max = input({ type: "number", placeholder: "max", "aria-label": "maximum" }, spec.maximum);
	const pattern = input({ type: "text", placeholder: "pattern", "aria-label": "pattern" }, spec.pattern);
	const row = el("div", { class: "schemarow" }, key, type, el("label", {}, must, " req"), choices, min, max, pattern,
		el("button", { type: "button", class: "linkish", onclick: () => { rows.splice(rows.indexOf(entry), 1); row.remove(); } }, "remove"));
	const entry = { row, read() {
		const out = { type: type.value };
		const numeric = type.value === "number" || type.value === "integer";
		const values = choices.value.split(",").map((v) => v.trim()).filter(Boolean);
		if (values.length) out.enum = numeric ? values.map(Number) : values;
		if (numeric && min.value !== "") out.minimum = Number(min.value);
		if (numeric && max.value !== "") out.maximum = Number(max.value);
		if (!numeric && pattern.value.trim()) out.pattern = pattern.value.trim();
		return { name: key.value.trim(), spec: out, required: must.checked };
	} };
	return entry;
}

/** The kind's schema as editable rows; Check shows what it would strand, Save runs crud on the kind doc. */
function schemaEditor(kind, kindDoc, path, rerender) {
	const schema = (kindDoc.meta && kindDoc.meta.schema) || {};
	const required = schema.required || [];
	const rows = [];
	const list = el("div", { class: "schemarows" });
	const add = (name, spec) => { const entry = schemaRow(name, spec || {}, required.includes(name), rows); rows.push(entry); list.append(entry.row); };
	for (const [name, spec] of Object.entries(schema.properties || {})) add(name, spec);
	const verdict = el("div", { class: "verdict" });
	const build = () => {
		const next = { type: "object", additionalProperties: false, properties: {} };
		const must = [];
		for (const entry of rows) {
			const field = entry.read();
			if (!field.name) continue;
			next.properties[field.name] = field.spec;
			if (field.required) must.push(field.name);
		}
		if (must.length) next.required = must;
		return next;
	};
	const check = async () => {
		const result = await (await fetch("/api/kind-check", {
			method: "POST",
			headers: { "x-helm-token": token, "content-type": "application/json" },
			body: JSON.stringify({ repo: kind.repoId, kind: kind.id, schema: build() }),
		})).json();
		const failures = result.failures || [];
		verdict.replaceChildren(failures.length
			? el("div", { class: "breaks" }, el("strong", {}, failures.length + " " + kind.name + " doc(s) would fail this schema:"),
				el("ul", {}, failures.map((f) => el("li", {},
					el("button", { class: "linkish", onclick: () => select([...path, { id: f.id, name: f.gist || f.id, kind: kind.name, repo: kind.repoId, kindRef: kind }]) }, f.gist || f.id),
					" ", el("span", { class: "rel" }, f.errors.join("; "))))))
			: el("span", { class: "ok" }, "Every " + kind.name + " doc fits this schema."));
		return failures.length;
	};
	const form = el("form", { class: "schema", title: kind.inCrudContext ? null : OUT_OF_REACH },
		el("fieldset", { disabled: kind.inCrudContext ? null : "" }, el("legend", {}, "schema"), list,
			el("div", { class: "schemaacts" },
				el("button", { type: "button", class: "linkish", onclick: () => add("", { type: "string" }) }, "+ field"),
				el("button", { type: "button", onclick: () => check().catch(showError) }, "Check"),
				el("button", { type: "submit" }, "Save schema")),
			verdict));
	onSubmit(form, async () => {
		try {
			const meta = Object.assign({}, kindDoc.meta, { schema: build() });
			const run = await write("/api/crud/meta", { id: kind.id, repo: kind.repoId, patch: meta, replace: true });
			refreshGroups();
			rerender(outputBox(run.stdout));
		} catch (err) {
			rerender(outputBox(String(err.message || err), true));
		}
	});
	return form;
}
`;
