import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { renderUpdatedBacklogMemo } from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, parseMarkdownDoc, readNosediveRc } from "../lib/coreParsing.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { posixRelPath } from "../lib/packageBacklog.js";
import { writeFileAtomic } from "../lib/renderPlan.js";
import { uuidLike } from "../lib/repoWorkspaceCore.js";

function updateBacklog(args: string[], io: CommandIo): void {
	if (args.length > 0) throw new Error(`unexpected update-backlog argument: ${args[0]}`);

	const rc = readNosediveRc(process.cwd());
	const memoId = rc.backlog;
	if (!memoId) throw new Error("update-backlog requires a configured backlog memo id");
	if (!uuidLike(memoId))
		throw new Error(`update-backlog requires a UUID-shaped backlog memo id: ${memoId}`);
	if (!rc.kbDir) throw new Error("update-backlog requires a configured kb directory");

	const memoPath = join(rc.kbDir, `${memoId}.md`);
	if (!existsSync(memoPath)) throw new Error(`bridge backlog memo not found: ${memoId}`);
	if (!statSync(memoPath).isFile()) throw new Error(`bridge backlog memo is not a file: ${memoId}`);
	const memo = parseMarkdownDoc(readFileSync(memoPath, "utf8"), formatPath(memoPath));
	if (memo.fm.scalars.kind && memo.fm.scalars.kind !== "memo") {
		throw new Error(`configured backlog doc must be kind: memo: ${memoId}`);
	}

	const content = renderUpdatedBacklogMemo(rc, memo, memoId, loadKbDocs(rc.kbDir, rc.bridgeDir));
	writeFileAtomic(memoPath, content);
	io.log(`Updated backlog memo: ${posixRelPath(rc.bridgeDir, memoPath)}`);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(updateBacklog, args);
}
