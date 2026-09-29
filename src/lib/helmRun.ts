import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { HelmRequestError } from "./helmWrites.js";
import { packageRoot } from "./packageBacklog.js";

function field(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new HelmRequestError(400, `${key} is required`);
}

/** The verbs the page may run -- the dive lifecycle and the workspace pair -- and the argv and stdin each becomes. */
function command(body: Record<string, unknown>): { args: string[]; stdin: string } {
	switch (body.verb) {
		case "dive":
			return {
				args: ["dive", field(body, "feat"), "--title", field(body, "title"), field(body, "gist")],
				stdin: field(body, "brief"),
			};
		case "jump":
			return { args: ["jump", field(body, "ref")], stdin: "" };
		case "pack":
			return { args: ["pack"], stdin: "" };
		case "land":
			return { args: ["land"], stdin: "" };
		case "bail":
			return { args: ["bail", "--reason", field(body, "reason")], stdin: "" };
		case "hydrate": {
			const at = typeof body.at === "string" && body.at.trim() ? ["--at", body.at.trim()] : [];
			return { args: ["hydrate-repo.workspace", field(body, "repo"), ...at], stdin: "" };
		}
		case "dehydrate":
			return { args: ["dehydrate-repo.workspace", field(body, "repo")], stdin: "" };
		default:
			throw new HelmRequestError(400, `helm does not run ${String(body.verb)}`);
	}
}

/**
 * Runs one dive verb from the same build helm runs from, streaming its output
 * to the page as it arrives and ending with `[exit <code>]`: a jump or a land
 * takes long enough that the pilot should watch it happen.
 */
export function streamVerb(cwd: string, body: Record<string, unknown>, res: ServerResponse): void {
	const { args, stdin } = command(body);
	res.writeHead(200, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	const child = spawn(process.execPath, [join(packageRoot(), "dist", "cli.js"), ...args], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => res.write(chunk));
	child.stderr.on("data", (chunk) => res.write(chunk));
	child.on("error", (err) => res.end(`\n${err.message}\n[exit 1]\n`));
	child.on("close", (code) => res.end(`\n[exit ${code ?? 1}]\n`));
	child.stdin.end(stdin);
}
