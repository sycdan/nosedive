import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

import { crudReach } from "./helm.js";
import { nosedivePackageVersion, packageRoot } from "./packageBacklog.js";

/** A request helm refuses on its merits, answered with its own status. */
export class HelmRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export interface CrudRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

const OUT_OF_REACH = "crud cannot write to that repo now: jump a dive that scopes it to edit";

/**
 * Runs `nosedive crud` from the same build helm runs from. Helm never writes a
 * doc itself: every write is the command a pilot would type, so a refusal is
 * the command's own and there is one implementation to trust.
 */
function runCrud(cwd: string, args: string[], stdin = ""): Promise<CrudRun> {
	return new Promise((resolveRun, reject) => {
		const child = spawn(
			process.execPath,
			[join(packageRoot(), "dist", "cli.js"), "crud", ...args],
			{
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolveRun({ exitCode: code ?? 1, stdout, stderr }));
		child.stdin.end(stdin);
	});
}

function succeeded(run: CrudRun): CrudRun {
	if (run.exitCode === 0) return run;
	const message = run.stderr.replace(/^nosedive: /gm, "").trim();
	throw new HelmRequestError(400, message || `crud exited ${run.exitCode}`);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	let text = "";
	for await (const chunk of req) {
		text += chunk;
		if (text.length > 64 * 1024) throw new HelmRequestError(413, "request body too large");
	}
	try {
		const body = JSON.parse(text) as unknown;
		if (body && typeof body === "object" && !Array.isArray(body))
			return body as Record<string, unknown>;
	} catch {
		// Reported below, the same as any other shape that is not an object.
	}
	throw new HelmRequestError(400, "request body must be a JSON object");
}

function text(body: Record<string, unknown>, key: string, required = true): string | undefined {
	const value = body[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	if (required) throw new HelmRequestError(400, `${key} is required`);
	return undefined;
}

/** The write a POST asks for, run through crud; undefined for a path that is not one. */
export async function helmWrite(
	cwd: string,
	path: string,
	req: IncomingMessage,
): Promise<CrudRun | undefined> {
	if (!path.startsWith("/api/crud/")) return undefined;
	const body = await readJsonBody(req);
	if (path === "/api/crud/mint") {
		const repo = text(body, "repo")!;
		if (!crudReach(cwd).has(repo)) throw new HelmRequestError(409, OUT_OF_REACH);
		const name = text(body, "name", false);
		return succeeded(
			await runCrud(cwd, [
				"--repo",
				repo,
				text(body, "kind")!,
				...(name ? ["--name", name] : []),
				text(body, "gist")!,
			]),
		);
	}
	if (path === "/api/crud/meta") {
		const patch = body.patch;
		if (!patch || typeof patch !== "object" || Array.isArray(patch))
			throw new HelmRequestError(400, "patch must be an object of meta keys");
		const repo = text(body, "repo", false);
		// JSON is YAML, so the patch goes to crud's stdin as it is.
		return succeeded(
			await runCrud(
				cwd,
				[...(repo ? ["--repo", repo] : []), text(body, "id")!, "--meta", "-"],
				JSON.stringify(patch),
			),
		);
	}
	if (path === "/api/crud/deck") {
		const gist =
			text(body, "gist", false) ||
			`Created by Nosedive Helm v${nosedivePackageVersion()} at ${new Date().toISOString().slice(0, 16)}Z`;
		return succeeded(await runCrud(cwd, ["deck", "--name", text(body, "name")!, gist]));
	}
	return undefined;
}
