/** The document search dialog, using the tree's current context. */
export const helmSearchScript = String.raw`
let searchDialog = null;
function openSearch() {
	if (searchDialog) { searchDialog.querySelector('input').focus(); return; }
	const input = el('input', { type: 'search', placeholder: 'Search docs (at least two characters)', 'aria-label': 'Search docs' });
	const results = el('div', { class: 'searchresults', 'aria-live': 'polite' });
	const dialog = el('dialog', { class: 'modal wide', 'aria-label': 'Search docs' },
		el('form', { onsubmit: (event) => event.preventDefault() }, el('h3', {}, 'Search'), input, results,
			el('div', { class: 'modalacts' }, el('button', { type: 'button', onclick: () => dialog.close() }, 'Close'))));
	searchDialog = dialog;
	let timer, version = 0, rows = [], selected = -1;
	const highlightSearch = (index) => {
		selected = index;
		rows.forEach((row, at) => { row.classList.toggle('current', at === index); row.setAttribute('aria-selected', String(at === index)); });
		rows[index]?.scrollIntoView({ block: 'nearest' });
	};
	const draw = async (request) => {
		if (input.value.trim().length < 2) { results.replaceChildren(el('p', { class: 'detail' }, 'Type at least two characters.')); return; }
		try {
			// Every repo in context, not just one picked in the tree.
			const params = new URLSearchParams(contextQuery(ctx.root, false).split('?')[1]);
			params.set('q', input.value);
			const found = await api('/api/search?' + params);
			if (request !== version || !dialog.open) return;
			rows = []; selected = -1;
			const parts = [];
			let repoId = null;
			for (const group of found.groups) {
				if (repoId !== group.repoId) { parts.push(el('h3', {}, group.repoName)); repoId = group.repoId; }
				parts.push(el('h4', {}, group.kind));
				for (const doc of group.docs) {
					const open = () => {
						dialog.close();
						const repo = treeContext?.repos.find((r) => r.id === group.repoId) || { id: group.repoId, name: group.repoName };
						const kind = treeContext?.kinds.find((k) => k.repoId === group.repoId && k.name === group.kind);
						select([repoStep(repo), ...(kind ? [{ id: kind.id, name: kind.name, kind: 'kind', repo: kind.repoId }] : []),
							{ id: doc.id, name: doc.title, kind: group.kind, repo: group.repoId, kindRef: kind }]);
					};
					const row = el('button', { type: 'button', class: 'searchrow', onclick: open, 'aria-selected': 'false' },
						el('span', {}, doc.title), el('span', { class: 'detail' }, [doc.name, doc.id.slice(-6), doc.gist].filter(Boolean).join(' · ')));
					rows.push(row); parts.push(row);
				}
				if (group.more) parts.push(el('p', { class: 'detail' }, '+' + group.more + ' more'));
			}
			if (!rows.length) parts.push(el('p', { class: 'detail' }, 'No matching docs.'));
			if (found.unsearched.length) parts.push(el('p', { class: 'detail' }, 'not searched (not hydrated): ' + found.unsearched.join(', ')));
			results.replaceChildren(...parts);
			highlightSearch(rows.length ? 0 : -1);
		} catch (err) { if (request === version && dialog.open) results.replaceChildren(el('p', {}, String(err.message || err))); }
	};
	input.addEventListener('input', () => {
		clearTimeout(timer); const request = ++version;
		rows = []; selected = -1;
		results.replaceChildren(el('p', { class: 'detail' }, input.value.trim().length < 2 ? 'Type at least two characters.' : 'Searching…'));
		timer = setTimeout(() => draw(request), 200);
	});
	dialog.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') { event.preventDefault(); dialog.close(); }
		else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (rows.length) highlightSearch((selected + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
		} else if (event.key === 'Enter' && selected >= 0 && event.target === input) { event.preventDefault(); rows[selected].click(); }
	});
	dialog.addEventListener('close', () => { clearTimeout(timer); ++version; searchDialog = null; dialog.remove(); });
	dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
	document.body.append(dialog); dialog.showModal(); input.focus(); draw(++version);
}
document.getElementById('searchbtn').addEventListener('click', openSearch);
document.addEventListener('keydown', (event) => {
	if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'e' &&
		!event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
		event.preventDefault(); openSearch();
	}
});
`;
