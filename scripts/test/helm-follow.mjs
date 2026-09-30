import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";

import {
	cli,
	createBridge,
	createTmp,
	gitCommitEmpty,
	libUrl,
	runTool,
	write,
} from "../test-helpers.mjs";

const { helmState } = await import(libUrl);
const tmp = createTmp("helm-follow");
const head = (cwd) => runTool("git", ["rev-parse", "HEAD"], cwd).stdout.trim();

/** A bridge with one commit, so HEAD resolves. */
function bridgeWithCommit(name) {
	const bridge = createBridge(tmp, name);
	runTool("git", ["add", "-A"], bridge);
	gitCommitEmpty(bridge, "init");
	return bridge;
}

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

/** Reads SSE events; each wait fails after 10 s instead of hanging. */
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
		next(label = "") {
			let timer;
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`no ${label} event within 10 s`)), 10000);
			});
			return Promise.race([read(), timeout]).finally(() => clearTimeout(timer));
		},
		cancel: () => reader.cancel(),
	};
}

test("helmState reads the active dive and the bridge's HEAD", () => {
	const bridge = bridgeWithCommit("unit");
	assert.deepEqual(helmState(bridge), { dive: null, head: head(bridge) });
	const dive = randomUUID();
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${dive}\n`);
	assert.deepEqual(helmState(bridge), { dive, head: head(bridge) });
});

test("an open event stream follows dives and commits made outside helm", async (t) => {
	const bridge = bridgeWithCommit("follow");
	const helm = startHelm(bridge);
	t.after(helm.stop);
	const base = await helm.url;
	const token = base.searchParams.get("token");
	const res = await fetch(new URL(`/api/events?token=${token}`, base));
	assert.equal(res.status, 200);
	const stream = events(res);
	// Stopping helm resets the socket, which a later cancel would report.
	t.after(() => stream.cancel().catch(() => {}));

	assert.equal((await stream.next("boot")).event, "boot");
	const baseline = await stream.next("baseline");
	assert.equal(baseline.event, "state");
	assert.deepEqual(JSON.parse(baseline.data), { dive: null, head: head(bridge) });

	const dive = randomUUID();
	write(join(bridge, "workspace", ".nosedive-ref"), `id: ${dive}\n`);
	const jumped = await stream.next("dive");
	assert.equal(jumped.event, "state");
	assert.deepEqual(JSON.parse(jumped.data), { dive, head: head(bridge) });

	gitCommitEmpty(bridge, "outside helm");
	const committed = await stream.next("commit");
	assert.equal(committed.event, "state");
	assert.deepEqual(JSON.parse(committed.data), { dive, head: head(bridge) });
});
