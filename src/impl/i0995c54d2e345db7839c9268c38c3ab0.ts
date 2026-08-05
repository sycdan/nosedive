import { resolve } from "node:path";

import { captureCommand } from "./commandAdapter.js";

import type { ImplCommandOutput, ImplRuntime } from "./types.js";

import { bridgeBacklogMemoBody } from "../lib/backlogDives.js";
import { CommandIo } from "../lib/bridgeSetupIo.js";
import { formatPath, readNosediveRc } from "../lib/coreParsing.js";
import { pilotIdentityLines, readPilotIdentity, readWorkspaceDiveMarker } from "../lib/gitState.js";
import { loadKbDocs } from "../lib/kbDocs.js";

function into(args: string[], io: CommandIo): void {
	const context = args.join(" ").trim();
	const rc = readNosediveRc(process.cwd());

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (marker.present && marker.id) {
		const kbDocs = rc.kbDir ? loadKbDocs(rc.kbDir, rc.bridgeDir) : [];
		const activeDive = kbDocs.find((doc) => doc.id === marker.id);
		const gist = activeDive?.gist ?? marker.id;
		throw new Error(`already diving into "${gist}", run nosedive pack first`);
	}

	const identity = readPilotIdentity(rc.bridgeDir);
	const localCli = formatPath(resolve(process.argv[1] ?? "nosedive"));

	io.log("== pilot identification ==");
	io.log(pilotIdentityLines(identity).trimEnd());
	io.log("");
	io.log("== open work: backlog ==");
	io.log(rc.kbDir ? bridgeBacklogMemoBody(rc) : "(no kb directory configured)");
	io.log("");
	io.log(`== pilot's context ==\n${context || "(none given)"}`);
	io.log("");
	io.log(
		`Local nosedive build (use this, not \`npx nosedive\` -- it lags behind local changes): ` +
			`\`node ${localCli} <command>\``,
	);
	io.log("");
	io.log(
		`Help pilot dive into "${context || "something"}" using the information above. ` +
			`Pick or pitch an effort, then call \`node ${localCli} record.dive --effort <effort-ref> --diver ${identity.email}\` ` +
			`to claim or create the dive (use --ref <dive-ref> instead of --effort to pick up an existing pending/packed ` +
			`dive from the backlog above). Then run \`node ${localCli} jump\`.`,
	);
}

export function run(args: string[], _runtime: ImplRuntime): Promise<ImplCommandOutput> {
	return captureCommand(into, args);
}
