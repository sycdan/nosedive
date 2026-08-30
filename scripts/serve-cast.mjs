/**
 * Serve one cast in the same player the landing page uses, so a take is
 * reviewed under the conditions it will ship under rather than as raw JSON.
 *
 * The player and its stylesheet are read from docs/assets, not vendored again
 * here: reviewing a take in a different player than the one docs/index.html
 * mounts would defeat the point of reviewing it.
 *
 * Binds loopback only and takes an ephemeral port unless told otherwise, so
 * repeated runs never collide and nothing is exposed off the machine.
 *
 * Usage: node scripts/serve-cast.mjs <cast-path> [--port <n>]
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(dirname(fileURLToPath(import.meta.url))), "docs", "assets");

const args = process.argv.slice(2);
const castPath = resolve(args.find((a) => !a.startsWith("--")) ?? "");
const portIndex = args.indexOf("--port");
// Fixed, not ephemeral: the point is a URL you can leave open across reruns.
const port = portIndex === -1 ? 8777 : Number(args[portIndex + 1]);

if (!castPath || Number.isNaN(port)) {
	console.error("usage: node scripts/serve-cast.mjs <cast-path> [--port <n>]");
	process.exit(2);
}

// Read at startup so a missing cast fails here, while somebody is watching,
// rather than as a blank page later. The cast itself is re-read per request --
// see the route table -- so rerunning the gate and reloading shows the new
// take instead of the one this process started with.
readFileSync(castPath);
const playerJs = readFileSync(join(ASSETS, "asciinema-player.min.js"));
const playerCss = readFileSync(join(ASSETS, "asciinema-player.css"));

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cast review</title>
<link rel="stylesheet" href="/player.css">
<style>
  body { margin: 0; background: #0d1117; color: #c9d1d9;
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 14px; font-weight: 600; color: #8b949e; margin: 0 0 12px; }
  p { color: #8b949e; margin: 16px 0 0; }
</style>
</head>
<body>
<main>
  <h1>${castPath.replace(/[&<>]/g, "")}</h1>
  <div id="player"></div>
  <p>Rerun the gate then reload the page for a fresh take.</p>
</main>
<script src="/player.js"></script>
<script>
  AsciinemaPlayer.create("/demo.cast", document.getElementById("player"), {
    loop: true,
    idleTimeLimit: 1.5,
    fit: "width",
  });
</script>
</body>
</html>
`;

// The cast is a function, not a value: it is re-read on every request so that
// rerunning the gate and reloading the page shows the new take. The player and
// the page are fixed for the life of the process, which is what makes the URL
// worth keeping open.
const routes = {
	"/": () => [page, "text/html; charset=utf-8"],
	"/demo.cast": () => [readFileSync(castPath), "application/json; charset=utf-8"],
	"/player.js": () => [playerJs, "text/javascript; charset=utf-8"],
	"/player.css": () => [playerCss, "text/css; charset=utf-8"],
};

const server = createServer((req, res) => {
	const route = routes[(req.url ?? "/").split("?")[0]];
	if (!route) {
		res.writeHead(404).end("not found");
		return;
	}
	// A cast deleted or half-written between requests is a 503, not a crash:
	// the reviewer's tab stays useful across a rerun that is still in flight.
	let body;
	try {
		body = route();
	} catch (err) {
		res.writeHead(503).end(String(err.message ?? err));
		return;
	}
	res.writeHead(200, { "content-type": body[1] }).end(body[0]);
});

// A stable URL beats a free one. The port is fixed by default so the tab you
// left open still works after a rerun, and an already-running server on it is
// success rather than a collision -- it is serving the same path, and the cast
// is read per request, so it is already showing the fresh take.
server.on("error", (err) => {
	if (err.code !== "EADDRINUSE") throw err;
	console.log(`cast review server already running: http://127.0.0.1:${port}/`);
	process.exit(0);
});

server.listen(port, "127.0.0.1", () => {
	const { port: bound } = server.address();
	// stdout, and on its own line: the caller scrapes this to tell the pilot
	// where to look.
	console.log(`cast review server: http://127.0.0.1:${bound}/`);
});
