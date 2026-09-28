/** The helm page's stylesheet: light and dark palettes, tree, cards and doc. */
export const helmStyle = String.raw`
:root {
	--bg: #f6f6f4; --panel: #ffffff; --line: #e3e3de; --text: #1c1c1a; --dim: #6b6b66;
	--accent: #2f6fdb; --hover: #ecece8; --ok: #1f8a4c; --warn: #b7791f; --off: #9a9a94;
	--radius: 8px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #131417; --panel: #1b1c20; --line: #2a2c31; --text: #e8e8e6; --dim: #8d8f96;
		--accent: #6ea0ff; --hover: #24262b; --ok: #4cc27f; --warn: #e0a84a; --off: #62646b;
		color-scheme: dark;
	}
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); display: grid;
	grid-template-rows: auto auto 1fr; grid-template-columns: minmax(260px, 340px) 1fr;
	font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { grid-column: 1 / -1; border-bottom: 1px solid var(--line); padding: 10px 16px;
	display: flex; gap: 12px; align-items: center; }
header h1 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); margin: 0; }
#crumbs { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; }
#crumbs .sep { color: var(--line); }
#crumbs button { border: 0; background: none; padding: 2px 4px; border-radius: 4px; cursor: pointer;
	color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 32ch; }
#crumbs button:hover { background: var(--hover); color: var(--text); }
#crumbs button:last-child { color: var(--text); font-weight: 600; }
aside { border-right: 1px solid var(--line); overflow: auto; padding: 8px 6px 24px; }
main { overflow: auto; padding: 16px 24px 48px; min-width: 0; }
button { font: inherit; color: inherit; }

/* tree */
.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.tree ul { padding-left: 14px; border-left: 1px solid var(--line); margin-left: 10px; }
.row { display: flex; align-items: center; gap: 2px; border-radius: 5px; min-height: 26px; }
.row:hover { background: var(--hover); }
.row.selected { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent); }
.twisty { width: 20px; height: 22px; border: 0; background: none; cursor: pointer; color: var(--dim);
	flex: none; padding: 0; font-size: 10px; }
.twisty:disabled { cursor: default; opacity: .35; }
.label { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 6px; border: 0; background: none;
	padding: 3px 4px; cursor: pointer; text-align: left; white-space: nowrap; overflow: hidden; text-decoration: none; }
.label .text { overflow: hidden; text-overflow: ellipsis; }
.deck > .row .label { font-weight: 600; }
.kind { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); flex: none; }
.rel { font-size: 11px; color: var(--dim); flex: none; }
.url .text { color: var(--accent); }
.file .text, .cycle .text { color: var(--dim); }

/* main */
.empty { color: var(--dim); padding: 48px 0; text-align: center; }
.cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 12px 14px; display: grid; gap: 8px; }
.card .name { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.icon { width: 22px; text-align: center; font-size: 17px; }
.gist { color: var(--dim); font-size: 12px; overflow: hidden;
	display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.facts { display: flex; flex-wrap: wrap; gap: 6px; }
.fact { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 8px;
	border-radius: 4px; background: var(--bg); color: var(--dim); }
.fact code { font-family: var(--mono); color: var(--text); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--off); }
.dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
.tag { font-size: 11px; color: var(--accent); font-weight: 500; }
details.fm { margin: 0 0 16px; }
details.fm summary { display: inline-block; cursor: pointer; color: var(--dim); font-size: 12px;
	padding: 2px 6px; border-radius: 4px; list-style: none; }
details.fm summary::before { content: "▸ "; }
details.fm[open] summary::before { content: "▾ "; }
details.fm summary:hover { background: var(--hover); color: var(--text); }
details.fm summary:focus { outline: none; }
details.fm summary:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
details.fm pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 10px 12px; overflow: auto; font: 12px/1.5 var(--mono); }
.doc { max-width: 80ch; }
.doc a { color: var(--accent); }
.doc pre { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
	padding: 10px 12px; overflow: auto; }
.doc code { font-family: var(--mono); font-size: 12.5px; }
.doc table { border-collapse: collapse; } .doc th, .doc td { border: 1px solid var(--line); padding: 4px 8px; }
.deck-body { margin-top: 24px; padding-top: 8px; border-top: 1px solid var(--line); }
.deck-body:empty { display: none; }
.group > .row .label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.out { opacity: .55; }
.picked > .row { box-shadow: inset 2px 0 0 var(--ok); }
.count { font-size: 11px; color: var(--dim); background: var(--hover); border-radius: 8px; padding: 0 6px; flex: none; }
.row .icon { width: 18px; font-size: 13px; flex: none; }
.card.out { opacity: .6; }
.doclist { list-style: none; padding: 0; margin: 0 0 16px; display: grid; gap: 4px; }
.doclist li { padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
.linkish { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-align: left; }
.start { max-width: 520px; margin: 48px auto; text-align: center; }
.start .empty { padding: 0 0 16px; }
form.make { display: flex; gap: 8px; margin: 0 0 12px; }
form.make input { flex: 1; min-width: 0; }
form.make input, form.meta input, form.meta select { font: inherit; padding: 6px 9px; border-radius: 6px;
	border: 1px solid var(--line); background: var(--panel); color: var(--text); }
form.make input:focus, form.meta input:focus, form.meta select:focus { outline: none; border-color: var(--accent); }
form.make button, form.meta button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 0; cursor: pointer;
	background: var(--accent); color: #fff; }
form button:disabled, fieldset:disabled button { opacity: .5; cursor: not-allowed; }
form.meta fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; margin: 0 0 16px;
	display: grid; gap: 8px; max-width: 520px; }
form.meta button { justify-self: start; }
form.meta legend { color: var(--dim); font-size: 12px; padding: 0 4px; }
.field { display: grid; grid-template-columns: 140px 1fr; align-items: center; gap: 10px; font-size: 13px; }
.field span { color: var(--dim); }
pre.output { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--ok);
	border-radius: 6px; padding: 8px 10px; margin: 0 0 12px; font: 12px/1.5 var(--mono); white-space: pre-wrap; }
pre.output.failed { border-left-color: #d64545; }
#divebar { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; padding: 6px 16px;
	border-bottom: 1px solid var(--line); font-size: 13px; min-height: 40px; }
#divebar .state { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
#divebar .gap { flex: 1; }
#divebar .reason { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line);
	background: var(--panel); color: var(--text); width: 14em; }
button.act { font: inherit; padding: 5px 12px; border-radius: 6px; border: 0; cursor: pointer; color: #fff; }
button.act.jump { background: #2f6fdb; } button.act.land { background: #1f8a4c; }
button.act.pack { background: #b7791f; } button.act.bail { background: #c53b3b; }
button.act.unstage { background: var(--hover); color: var(--text); }
body.diving { box-shadow: inset 0 0 0 3px #1f8a4c; }
body.diving #divebar { background: color-mix(in srgb, #1f8a4c 10%, var(--bg)); }
.picker { margin: 0 0 24px; }
.picker input[type=search] { font: inherit; padding: 6px 9px; border-radius: 6px; border: 1px solid var(--line);
	background: var(--panel); color: var(--text); width: 100%; max-width: 420px; margin: 0 0 12px; }
form.newdive { display: grid; gap: 6px; max-width: 520px; margin-top: 16px; }
form.newdive input, form.newdive textarea { font: inherit; padding: 6px 9px; border-radius: 6px;
	border: 1px solid var(--line); background: var(--panel); color: var(--text); }
form.newdive button { justify-self: start; font: inherit; padding: 6px 14px; border-radius: 6px; border: 0;
	cursor: pointer; background: var(--accent); color: #fff; }
pre.output.streaming { border-left-color: var(--accent); }
pre.output { max-height: 70vh; overflow: auto; }
.cardacts { display: flex; gap: 6px; }
.cardacts form.make { margin: 0; }
form.schema fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px; margin: 0 0 16px; }
form.schema legend { color: var(--dim); font-size: 12px; padding: 0 4px; }
.schemarow { display: grid; grid-template-columns: 1.2fr .9fr auto 1.4fr .6fr .6fr 1fr auto; gap: 6px; align-items: center; margin: 0 0 6px; }
.schemarow input, .schemarow select { font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 5px; min-width: 0;
	border: 1px solid var(--line); background: var(--panel); color: var(--text); }
.schemarow label { font-size: 12px; color: var(--dim); white-space: nowrap; }
.schemaacts { display: flex; gap: 8px; align-items: center; margin: 8px 0 0; }
.schemaacts button:not(.linkish) { font: inherit; padding: 5px 12px; border-radius: 6px; border: 0; cursor: pointer; background: var(--accent); color: #fff; }
.verdict { margin-top: 8px; font-size: 13px; }
.verdict .ok { color: var(--ok); }
.breaks ul { margin: 6px 0 0; padding-left: 18px; }
#error { color: #d64545; white-space: pre-wrap; font-family: var(--mono); margin: 0 0 12px; }
`;
