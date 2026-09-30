import { DECK_KIND_ID } from "./kinds.js";

/**
 * The dive bar's create control, spliced into the page's script: a kinds
 * dropdown grouped by repo and an Add button opening a modal whose form is
 * the kind's schema. Every create runs `nosedive crud`.
 */
export const helmCreateScript = String.raw`
// --- create -----------------------------------------------------------------

const DECK_KIND = "${DECK_KIND_ID}";
/** The kinds the active dive can make, by repo then name; none with no dive. */
let creatable = [];
/** The kind last picked, by repo and id, so redrawing the bar keeps it. */
let pickedKind = null;

async function loadCreatable() {
	creatable = dives.active ? await api("/api/creatable") : [];
}

function createControl() {
	if (!creatable.length) return [];
	const byRepo = new Map();
	creatable.forEach((kind, index) => {
		if (!byRepo.has(kind.repoName)) byRepo.set(kind.repoName, []);
		byRepo.get(kind.repoName).push(el("option", { value: String(index), title: kind.gist }, kind.name));
	});
	const picker = el("select", { class: "kindpick", "aria-label": "Kind to create" },
		[...byRepo].map(([repo, options]) => el("optgroup", { label: repo }, options)));
	const kept = creatable.findIndex((kind) => pickedKind && kind.id === pickedKind.id && kind.repoId === pickedKind.repoId);
	if (kept !== -1) picker.value = String(kept);
	picker.addEventListener("change", () => { pickedKind = creatable[Number(picker.value)]; });
	return [picker, el("button", { class: "act jump", onclick: () => createDialog(creatable[Number(picker.value)]) }, "Add")];
}

/** A new doc's meta from the modal's fields: an empty field is left out, and an unticked box unless required. */
function newMeta(inputs, required) {
	const meta = {};
	for (const input of inputs) {
		const key = input.name;
		if (input.dataset.kind === "boolean") {
			if (input.checked || required.includes(key)) meta[key] = input.checked;
		} else if (input.value !== "") {
			meta[key] = input.dataset.kind === "number" || input.dataset.kind === "integer" ? Number(input.value) : input.value;
		}
	}
	return meta;
}

/**
 * The form a kind's schema makes, in a modal because a schema can be long:
 * gist and name, then a field per property, required ones starred. A
 * property no simple field can hold is left to crud <quid> --meta -. A
 * refusal keeps every field; a create offers to open the new doc.
 */
function createDialog(kind) {
	const isDeck = kind.id === DECK_KIND;
	const schema = kind.schema || {};
	const properties = schema.properties || {};
	const required = schema.required || [];
	// A deck is known by its name; helm stamps a gist left empty.
	const gist = el("input", { type: "text", placeholder: isDeck ? "What's the deck for?" : "Gist", required: isDeck ? null : "", "aria-label": "gist" });
	const name = el("input", { type: "text", placeholder: isDeck ? "Name" : "name (optional)", required: isDeck ? "" : null, "aria-label": "name" });
	// A property built from other schemas (a kind's own schema, say) is no simple field.
	const composite = (spec) => !spec.type && !Array.isArray(spec.enum) && !!(spec.allOf || spec.anyOf || spec.oneOf || spec.$ref || spec.properties);
	const inputs = Object.entries(properties).filter(([, spec]) => !composite(spec || {}))
		.map(([key, spec]) => fieldFor(key, spec || {}, undefined)).filter((input) => !input.disabled);
	for (const input of inputs) if (required.includes(input.name) && input.dataset.kind !== "boolean") input.required = true;
	const rows = inputs.map((input) => el("label", { class: "field" },
		el("span", {}, input.name + (required.includes(input.name) ? " *" : "")), input));
	const out = el("pre", { class: "output", hidden: "" });
	const create = el("button", { type: "submit", class: "act jump" }, "Create");
	const actions = el("div", { class: "modalacts" },
		el("button", { type: "button", class: "act unstage", onclick: () => dialog.close() }, "Close"), create);
	const form = el("form", {},
		el("h3", {}, "New " + kind.name + " in " + kind.repoName),
		el("p", { class: "detail" }, kind.gist),
		...(isDeck ? [name, gist] : [gist, name]),
		rows.length ? el("fieldset", { class: "meta" }, el("legend", {}, "meta"), rows) : null,
		out, actions);
	const dialog = el("dialog", { class: "modal wide" }, form);
	dialog.addEventListener("close", () => dialog.remove());
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		create.disabled = true;
		try {
			const meta = newMeta(inputs, required);
			const run = isDeck
				? await write("/api/crud/deck", { name: name.value, gist: gist.value || undefined })
				: await write("/api/crud/mint", {
					repo: kind.repoId, kind: kind.name, gist: gist.value, name: name.value || undefined,
					meta: Object.keys(meta).length ? meta : undefined,
				});
			out.textContent = run.stdout;
			out.classList.remove("failed");
			const id = /Minted \S*?([0-9a-f-]{36})\.md/.exec(run.stdout);
			refreshRepos();
			if (isDeck) await loadDecks();
			// A new kind can be made at once; the dropdown and its schemas are read again.
			await loadCreatable();
			renderBar();
			if (id) {
				const title = gist.value || name.value;
				actions.replaceChildren(
					el("button", { type: "button", class: "act unstage", onclick: () => dialog.close() }, "Close"),
					el("button", { type: "button", class: "act jump", onclick: () => {
						dialog.close();
						// The kind rides along, so the new doc opens with its meta form.
						const kindRef = { id: kind.id, repoId: kind.repoId, name: kind.name, inCrudContext: true };
						select([deckStep(ctx.deck), { id: id[1], name: title, kind: kind.name, repo: kind.repoId, kindRef }]);
					} }, "View"));
			}
		} catch (err) {
			out.textContent = String(err.message || err);
			out.classList.add("failed");
			create.disabled = false;
		}
		out.hidden = false;
	});
	document.body.append(dialog);
	dialog.showModal();
	(isDeck ? name : gist).focus();
}

/**
 * On a dive, a doc that is not yet a feat of the picked deck can become one:
 * linked from the deck as <type>.feat, or from one of its feats as
 * child.feat, through crud <deck-or-feat> --links -.
 */
function featLinker(doc, step) {
	if (!dives.active || !ctx.deck || doc.kind === "dive" || doc.kind === "deck" || doc.id === ctx.deck) return null;
	if (isFeatStep(step) || deckFeats.some((feat) => feat.id === doc.id)) return null;
	return el("div", { class: "cardacts" },
		el("button", { class: "act unstage", onclick: () => featDialog(doc) }, "Add as feat"));
}

function featDialog(doc) {
	const types = [...new Set(deckFeats.map((feat) => (feat.rel || "").replace(/\.feat$/, "")).filter((t) => t && t !== "zerostar"))];
	const onDeck = el("input", { type: "radio", name: "place", value: "deck", checked: "" });
	const underFeat = el("input", { type: "radio", name: "place", value: "feat", disabled: deckFeats.length ? null : "" });
	const type = el("input", { type: "text", placeholder: "type, e.g. " + (types[0] || "current"), list: "feat-types",
		pattern: "[a-z0-9]+(-[a-z0-9]+)*", "aria-label": "type" });
	const parent = el("select", { "aria-label": "parent feat" },
		deckFeats.map((feat) => el("option", { value: feat.id }, label(feat))));
	const out = el("pre", { class: "output", hidden: "" });
	const add = el("button", { type: "submit", class: "act jump" }, "Add");
	const form = el("form", {},
		el("h3", {}, "Add " + label(doc) + " as a feat"),
		el("datalist", { id: "feat-types" }, types.map((t) => el("option", { value: t }))),
		el("label", { class: "field" }, el("span", {}, onDeck, " on " + deckNames.get(ctx.deck)), type),
		el("label", { class: "field" }, el("span", {}, underFeat, " under a feat"), parent),
		out,
		el("div", { class: "modalacts" },
			el("button", { type: "button", class: "act unstage", onclick: () => dialog.close() }, "Close"), add));
	const dialog = el("dialog", { class: "modal" }, form);
	dialog.addEventListener("close", () => dialog.remove());
	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const nested = underFeat.checked;
		if (!nested && !type.value.trim()) return type.focus();
		add.disabled = true;
		try {
			const rel = nested ? "child.feat" : type.value.trim() + ".feat";
			const run = await write("/api/crud/links", { id: nested ? parent.value : ctx.deck, patch: { [doc.id]: { rel } } });
			dialog.close();
			await loadDecks();
			select([deckStep(ctx.deck), { id: doc.id, name: label(doc), kind: doc.kind, rel }], null, outputBox(run.stdout));
		} catch (err) {
			out.textContent = String(err.message || err);
			out.classList.add("failed");
			out.hidden = false;
			add.disabled = false;
		}
	});
	document.body.append(dialog);
	dialog.showModal();
	type.focus();
}
`;
