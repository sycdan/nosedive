import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { cli, createBridge, createTmp, gitCommitEmpty, libUrl, runTool } from "../test-helpers.mjs";

const { helmLogPath } = await import(libUrl);
const tmp = createTmp("helm-internals");

function startHelm(cwd) {
	const child = spawn(process.execPath, [cli, "helm"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	let err = "";
	const url = new Promise((resolveUrl, reject) => {
		child.stdout.on("data", (chunk) => {
			out += chunk;
			const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/.exec(out);
			if (match) resolveUrl(new URL(match[1]));
		});
		child.stderr.on("data", (chunk) => (err += chunk));
		child.on("exit", (code) => reject(new Error(`helm exited ${code}\n${out}\n${err}`)));
	});
	url.catch(() => {});
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	const stop = () => {
		child.kill();
		return exited;
	};
	return { url, stop };
}

/** Reads SSE events until one named `name` arrives; fails after `ms` instead of hanging. */
function events(res) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const read = async () => {
		while (!buffer.includes("\n\n")) buffer += decoder.decode((await reader.read()).value);
		const end = buffer.indexOf("\n\n");
		const block = buffer.slice(0, end);
		buffer = buffer.slice(end + 2);
		return {
			event: /^event: (.*)$/m.exec(block)?.[1],
			data: /^data: (.*)$/m.exec(block)?.[1],
		};
	};
	return {
		async until(name, ms, accept = () => true) {
			let timer;
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`no ${name} event within ${ms} ms`)), ms);
			});
			const find = async () => {
				for (;;) {
					const next = await read();
					if (next.event === name && accept(next)) return next;
				}
			};
			return Promise.race([find(), timeout]).finally(() => clearTimeout(timer));
		},
		cancel: () => reader.cancel(),
	};
}

test("helm shows its internals and streams poll ticks and the live log", async (t) => {
	const bridge = createBridge(tmp, "internals");
	runTool("git", ["add", "-A"], bridge);
	gitCommitEmpty(bridge, "init");
	const helm = startHelm(bridge);
	t.after(helm.stop);
	const base = await helm.url;
	const token = base.searchParams.get("token");

	const internals = new URL("/api/internals", base);
	assert.equal((await fetch(internals)).status, 403);
	const res = await fetch(internals, { headers: { "x-helm-token": token } });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.config, readFileSync(join(bridge, ".nosedive", "config.yaml"), "utf8"));
	assert.equal(body.pollEvery, 2000);
	assert.equal(body.lastChangeAt, null);

	// The bridge's HEAD comes first; "init" is not on origin, "base" is.
	const head = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();
	assert.ok(head.startsWith(body.commits[0].hash));
	assert.equal(body.commits[0].subject, "init");
	assert.equal(body.commits[0].pushed, false);
	assert.equal(body.commits[1].subject, "base");
	assert.equal(body.commits[1].pushed, true);
	assert.equal(typeof body.commits[0].author, "string");
	assert.equal(typeof body.commits[0].at, "number");

	// A new unpushed commit leads the list.
	gitCommitEmpty(bridge, "fresh work");
	const after = await (await fetch(internals, { headers: { "x-helm-token": token } })).json();
	const fresh = runTool("git", ["rev-parse", "HEAD"], bridge).stdout.trim();
	assert.ok(fresh.startsWith(after.commits[0].hash));
	assert.equal(after.commits[0].subject, "fresh work");
	assert.equal(after.commits[0].pushed, false);
	assert.equal(after.commits.find((c) => c.subject === "base").pushed, true);

	const stream = events(await fetch(new URL(`/api/events?token=${token}`, base)));
	t.after(() => stream.cancel().catch(() => {}));

	const poll = JSON.parse((await stream.until("poll", 5000)).data);
	assert.equal(typeof poll.at, "number");
	assert.equal(typeof poll.every, "number");

	// An entry as helm's own log writes it.
	const path = helmLogPath(bridge, new Date());
	const header = `## ${new Date().toISOString()} [no dive] nosedive status`;
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${header}\n\nall fine\n\n`);
	await stream.until("log", 10000, (event) => JSON.parse(event.data).includes(header));
});
