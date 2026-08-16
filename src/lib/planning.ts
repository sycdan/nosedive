import { bridgeBacklogMemoBody } from "./backlogDives.js";
import { CommandIo } from "./bridgeSetupIo.js";
import { readNosediveRc } from "./coreParsing.js";
import { pilotIdentityLines, readPilotIdentity, readWorkspaceDiveMarker } from "./gitState.js";
import { loadKbDocs } from "./kbDocs.js";
import { nosediveInvocation } from "./packageBacklog.js";

export function runPlanningPrompt(args: string[], io: CommandIo): void {
	const context = args.join(" ").trim();
	const rc = readNosediveRc(process.cwd());

	const marker = readWorkspaceDiveMarker(rc.workspaceDir);
	if (marker.present && marker.id) {
		const kbDocs = rc.kbDir ? loadKbDocs(rc.kbDir, rc.bridgeDir) : [];
		const activeDive = kbDocs.find((doc) => doc.id === marker.id);
		if (!activeDive || activeDive.kind !== "dive")
			throw new Error(`active dive marker names no kind: dive doc: ${marker.id}`);
		const diver = activeDive.metaScalars.diver;
		if (diver) {
			const next =
				diver === readPilotIdentity(rc.bridgeDir).email
					? "run nosedive pack, bail, or land first"
					: `held by ${diver}; take it over with \`nosedive record.dive --ref ${marker.id} --takeover\``;
			throw new Error(`dive ${marker.id} (${activeDive.gist}) is ${next}`);
		}
		const patches = activeDive.links.filter((link) => link.rel === "patch").length;
		io.log(
			`warning: unheld marked dive ${marker.id} (${activeDive.gist}) has ${patches} patch chain(s); ` +
				`resume it with \`nosedive record.dive --ref ${marker.id}\``,
		);
	}

	const identity = readPilotIdentity(rc.bridgeDir);
	const cli = nosediveInvocation();

	io.log("== pilot identification ==");
	io.log(pilotIdentityLines(identity).trimEnd());
	io.log("");
	io.log("== open work: backlog ==");
	io.log(rc.kbDir ? bridgeBacklogMemoBody(rc) : "(no kb directory configured)");
	io.log("");
	io.log(`== pilot's context ==\n${context || "(none given)"}`);
	io.log("");
	io.log(
		`Help the pilot choose which feat to plan using the backlog and context above. ` +
			`Do not choose for them, and do not start work they have not selected. ` +
			`Once they choose, inspect the feat and its scoped repos, then break the feat into vertical slices at its logical seams.`,
	);
	io.log("");
	io.log(
		`Each slice must deliver one end-to-end behavior and represent no more than half a day's work from the planner's perspective. ` +
			`Record each one with \`${cli} record.dive --feat <feat-ref> --gist "<gist>" --title "<title>" --brief "<brief>"\`. ` +
			`Leave planned dives unclaimed: do not pass --diver.`,
	);
	io.log("");
	io.log(
		`Every dive must link a runnable gate with \`rel: land.gate\`. ` +
			`Write the gate's failing test against the feat's current scoped refs and run it before implementation begins to confirm that it fails for the intended reason. ` +
			`The dive's brief must name the failing behavior and the condition that must pass before the dive can land.`,
	);
	io.log("");
	io.log(
		"Stop once all slices are recorded, linked to their gates, and their tests are confirmed failing. " +
			"Do not jump into or implement any planned dive.",
	);
}
