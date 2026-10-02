import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { readNosediveRc } from "./coreParsing.js";
import { appendHelmLog } from "./helmLog.js";
import { readActiveDiveId } from "./kbDocs.js";
import { HelmRequestError } from "./helmWrites.js";
import { packageRoot } from "./packageBacklog.js";

/** Terminal colour and cursor codes: a page shows them as noise. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function field(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	throw new HelmRequestError(400, `${key} is required`);
}

/** The verbs the page may run -- the dive lifecycle, a note, and the workspace pair -- and the argv and stdin each becomes. */
function command(body: Record<string, unknown>): { args: string[]; stdin: string } {
	switch (body.verb) {
		case "jump": {
			const root =
				typeof body.root === "string" && body.root.trim() ? ["--root", body.root.trim()] : [];
			return { args: ["jump", field(body, "ref"), ...root], stdin: "" };
		}
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
		case "note": {
			// The first line is the gist, a leading `<prefix>:` included, as `nosedive note` reads it.
			const [first, ...rest] = field(body, "text").split(/\r?\n/);
			const noteBody = rest.join("\n").trim();
			const scopes = Array.isArray(body.scopes)
				? body.scopes.filter((scope): scope is string => typeof scope === "string" && scope !== "")
				: [];
			return {
				args: [
					"note",
					...first!.trim().split(/\s+/),
					...scopes.flatMap((scope) => ["--scope", scope]),
					...(noteBody ? ["--body", "-"] : []),
				],
				stdin: noteBody,
			};
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
	// Read before the run: a land or a bail ends the dive its entry belongs to.
	const activeDive = () => readActiveDiveId(readNosediveRc(cwd).workspaceDir);
	const diveBefore = activeDive();
	let transcript = "";
	const out = (text: string) => {
		transcript += text;
		res.write(text);
	};
	const end = (text: string) => {
		transcript += text;
		// Logged before the response ends, so what the page shows is already on disk.
		// A jump starts a dive, so its dive is known only once it has run.
		appendHelmLog(cwd, diveBefore ?? activeDive(), args, transcript);
		res.end(text);
	};
	const child = spawn(process.execPath, [join(packageRoot(), "dist", "cli.js"), ...args], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	// Decoded as text so an escape split across chunks is never half-stripped mid-character.
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => out(chunk.replace(ANSI, "")));
	child.stderr.on("data", (chunk: string) => out(chunk.replace(ANSI, "")));
	child.on("error", (err) => end(`\n${err.message}\n[exit 1]\n`));
	child.on("close", (code) => end(`\n[exit ${code ?? 1}]\n`));
	child.stdin.end(stdin);
}
