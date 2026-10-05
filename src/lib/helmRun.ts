import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { join } from "node:path";

import { readNosediveRc } from "./coreParsing.js";
import { featWorkBranch, inheritedScopes } from "./diveScopes.js";
import { helmRepoDoc } from "./helmLinks.js";
import { appendHelmLog } from "./helmLog.js";
import { bridgeView } from "./helmView.js";
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

type Step = { args: string[]; stdin: string };

/**
 * What a doc with no scopes of its own inherits from its nearest scoped
 * ancestor, work branches included, as crud patch entries: adding one scope
 * must not cut its dives off from the rest. Not the backlog's: every dive
 * takes those anyway.
 */
function inheritedPatch(
	cwd: string,
	ref: string,
): Record<string, { "work-branch": string | null }> {
	const view = bridgeView(cwd);
	const doc = view.docs.find((candidate) => candidate.id === ref) ?? helmRepoDoc(view, ref);
	if (!doc || doc.scopes.length > 0) return {};
	const { scopes, source } = inheritedScopes(doc, view.docs);
	if (!source || source.id === view.rc.backlog) return {};
	return Object.fromEntries(
		scopes.map((scope) => [
			scope.repoId,
			{ "work-branch": featWorkBranch(scope.repoId, view.rc, view.docs, doc) ?? null },
		]),
	);
}

/** The commands one verb runs, in order: a read-only add upscopes, then clears the branch it was given. */
function steps(cwd: string, body: Record<string, unknown>): Step[] {
	if (body.verb !== "upscope" || body.readOnly !== true) return [command(cwd, body)];
	const patch = { [field(body, "repo")]: { "work-branch": null } };
	return [
		command(cwd, { ...body, branch: "" }),
		{ args: ["crud", field(body, "dive"), "--scopes", "-"], stdin: JSON.stringify(patch) },
	];
}

/** The verbs the page may run -- the dive lifecycle, a note, the workspace pair and scope edits -- and the argv and stdin each becomes. */
function command(cwd: string, body: Record<string, unknown>): Step {
	switch (body.verb) {
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
		// A dive's scopes, by the dive's own edits.
		case "repin":
			return {
				args: [
					"crud",
					field(body, "dive"),
					"--repin",
					field(body, "ref"),
					"--scope",
					field(body, "repo"),
				],
				stdin: "",
			};
		case "upscope": {
			const branch = typeof body.branch === "string" ? body.branch.trim() : "";
			return {
				args: [
					"record.dive",
					"--ref",
					field(body, "dive"),
					"--upscope",
					field(body, "repo"),
					...(branch ? ["--work-branch", branch] : []),
				],
				stdin: "",
			};
		}
		case "unscope":
			return {
				args: ["record.dive", "--ref", field(body, "dive"), "--unscope", field(body, "repo")],
				stdin: "",
			};
		// A feat's or the backlog's scopes, by crud's merge patch: null drops one,
		// a branch or none sets it. `<repo>:kb/<id>.md` is crud's `<repo>:<id>`.
		case "feat-scope": {
			const repo = field(body, "repo");
			const branch = typeof body.branch === "string" ? body.branch.trim() : "";
			const doc = field(body, "doc").replace(/^([^:]+):kb\/([^/]+)\.md$/, "$1:$2");
			const patch =
				body.drop === true
					? { [repo]: null }
					: {
							...inheritedPatch(cwd, field(body, "doc")),
							[repo]: { "work-branch": branch || null },
						};
			return { args: ["crud", doc, "--scopes", "-"], stdin: JSON.stringify(patch) };
		}
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
	const queue = steps(cwd, body);
	res.writeHead(200, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	// Read before the run: a land or a bail ends the dive its entry belongs to.
	const activeDive = () => readActiveDiveId(readNosediveRc(cwd).workspaceDir);
	const diveBefore = activeDive();
	const run = ({ args, stdin }: Step) => {
		let transcript = "";
		const out = (text: string) => {
			transcript += text;
			res.write(text);
		};
		const end = (code: number) => {
			transcript += `\n[exit ${code}]\n`;
			// Logged before the response ends, so what the page shows is already on disk.
			// A jump starts a dive, so its dive is known only once it has run.
			appendHelmLog(cwd, diveBefore ?? activeDive(), args, transcript);
			// A later step runs only after this one succeeds; the page sees one exit.
			const next = code === 0 ? queue.shift() : undefined;
			if (next) {
				res.write("\n");
				run(next);
			} else res.end(`\n[exit ${code}]\n`);
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
		child.on("error", (err) => {
			out(`\n${err.message}`);
			end(1);
		});
		child.on("close", (code) => end(code ?? 1));
		child.stdin.end(stdin);
	};
	run(queue.shift()!);
}
