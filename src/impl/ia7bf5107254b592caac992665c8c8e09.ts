import { readNosediveRc } from "../lib/coreParsing.js";
import {
	collectDropReadiness,
	parseDropArgs,
	resolveBridgeRepoDoc,
	resolveDropFeat,
	todayIsoDate,
} from "../lib/drop.js";
import {
	readPromptBody,
	renderDropPrompt,
	resolvePromptDoc,
	resolveRunnerUsage,
} from "../lib/dropPrompt.js";
import { loadKbDocs } from "../lib/kbDocs.js";
import { collectLandGates } from "../lib/landGates.js";
import type { ImplCommandOutput, ImplRuntime } from "./types.js";

export function run(args: string[], runtime: ImplRuntime): ImplCommandOutput {
	const options = parseDropArgs(args);
	const rc = readNosediveRc(runtime.cwd);
	if (!rc.kbDir) throw new Error("drop requires a configured kb directory");

	const kbDocs = loadKbDocs(rc.kbDir, rc.bridgeDir);
	const feat = resolveDropFeat(kbDocs, options.name);
	const readiness = collectDropReadiness(feat, kbDocs, rc);
	if (readiness.blockers.length > 0) {
		return {
			stdout: "",
			stderr: `${["drop blocked:", ...readiness.blockers.map((blocker) => `- ${blocker}`)].join("\n")}\n`,
			exitCode: 1,
		};
	}

	const bridgeRepo = resolveBridgeRepoDoc(kbDocs, rc.bridgeDir);
	const roots = [
		feat,
		...readiness.repos.map((repo) => repo.doc),
		...(bridgeRepo ? [bridgeRepo] : []),
	];
	const gates = collectLandGates("land", roots, kbDocs, rc.bridgeDir);
	const promptDoc = resolvePromptDoc(kbDocs, rc, "drop");
	return {
		stdout: renderDropPrompt(readPromptBody(promptDoc), {
			feat,
			today: todayIsoDate(),
			repos: readiness.repos,
			gates,
			bridgeRepoNote: bridgeRepo
				? undefined
				: "no kind: repo doc matches a bridge git remote; bridge gates were not added",
		}),
		stderr: "",
		exitCode: 0,
	};
}
