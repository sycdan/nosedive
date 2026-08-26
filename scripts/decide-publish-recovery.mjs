import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPublishFinalization, git } from "./check-publish-finalization.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where a publish run should pick up, given the commit its push event named and
 * where main sits now:
 *
 * - `rerun` -- main is still the source, so no managed push survived and the
 *   whole finalization can run again from the start;
 * - `resume <version>` -- main is a valid finalization of this source, so an
 *   earlier attempt already stamped a version; publish that one, mint nothing;
 * - `superseded` -- main is anything else, so a newer head owns finalization
 *   and this run has to leave without publishing.
 *
 * Validity is `checkPublishFinalization` and nothing else, deliberately: a
 * second copy of those conditions would drift out of agreement with the first.
 *
 * A re-attempt counter answers none of this. `github.run_attempt` reports only
 * that this is attempt two, never which of the three states it woke up in.
 */
export function decidePublishRecovery({ repo = root, source, main }) {
	const sourceSha = git(repo, ["rev-parse", "--verify", `${source}^{commit}`]).trim();
	const mainSha = git(repo, ["rev-parse", "--verify", `${main}^{commit}`]).trim();

	if (mainSha === sourceSha) return { state: "rerun", source: sourceSha, main: mainSha };

	const finalization = checkPublishFinalization({ repo, commit: mainSha, source: sourceSha });
	if (finalization.ok) {
		return { state: "resume", source: sourceSha, main: mainSha, version: finalization.version };
	}
	return {
		state: "superseded",
		source: sourceSha,
		main: mainSha,
		reason: `${finalization.condition}: ${finalization.detail}`,
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [source, main] = process.argv.slice(2);
	if (!source || !main) {
		console.error("usage: node scripts/decide-publish-recovery.mjs <source-sha> <main>");
		process.exit(2);
	}
	const decision = decidePublishRecovery({ source, main });
	// Two `key=value` lines and nothing else on stdout, so a workflow step can
	// append them to $GITHUB_OUTPUT and branch on them without reading prose.
	// `version` is always present, empty unless there is a version to resume.
	console.log(`state=${decision.state}`);
	console.log(`version=${decision.version ?? ""}`);
	if (decision.reason)
		console.error(`main ${decision.main} is not this run's work: ${decision.reason}`);
}
