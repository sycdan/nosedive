import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPublishFinalization, git } from "./check-publish-finalization.mjs";
import { releaseVersion } from "./version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function taggedCommit(repo, tag) {
	try {
		return git(repo, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]).trim();
	} catch {
		return undefined;
	}
}

/**
 * What a manual stable dispatch is allowed to release, or why it is not allowed
 * to release anything.
 *
 * A stable release is a rename of one dev build, so the only thing a dispatch
 * chooses is which finalization commit to promote. Everything else follows from
 * that commit: its own version trailer names the dev build, and the date in that
 * version names the release. Nothing here reads a clock.
 *
 * The candidate must be a managed finalization, which is `checkPublishFinalization`
 * again -- here against the commit's own parent, since a finalization names the
 * source it was built from and sits directly on top of it.
 *
 * An existing `v<date>` tag is the record of which candidate already owns that
 * date. Pointing at this one means the dispatch is a rerun and may repair
 * whatever is missing; pointing anywhere else means a different dev build
 * already shipped as that release, and replacing it would rewrite what people
 * already installed.
 *
 * @see kb/01a03e18-7fe4-7f5c-93f3-64825b38599f.md
 */
export function decideStableRelease({ repo = root, source, ref }) {
	if (ref !== "main") throw new Error(`a stable release is dispatched on main, not ${ref}`);

	const sourceSha = git(repo, ["rev-parse", "--verify", `${source}^{commit}`]).trim();
	const parent = git(repo, ["rev-parse", "--verify", `${sourceSha}^`]).trim();
	const finalization = checkPublishFinalization({ repo, commit: sourceSha, source: parent });
	if (!finalization.ok) {
		throw new Error(
			`${sourceSha} is not a managed finalization (${finalization.condition}): ${finalization.detail}`,
		);
	}

	const dev = finalization.version;
	const stable = releaseVersion(dev);
	const tag = `v${stable}`;
	const tagged = taggedCommit(repo, tag);
	if (tagged && tagged !== sourceSha) {
		throw new Error(`${tag} already releases ${tagged}; refusing to move it to ${sourceSha}`);
	}

	return { source: sourceSha, dev, stable, tag };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [source, ref] = process.argv.slice(2);
	if (!source || !ref) {
		console.error("usage: node scripts/decide-stable-release.mjs <source-sha> <ref-name>");
		process.exit(2);
	}
	try {
		const decision = decideStableRelease({ source, ref });
		console.log(`source=${decision.source}`);
		console.log(`dev=${decision.dev}`);
		console.log(`stable=${decision.stable}`);
		console.log(`tag=${decision.tag}`);
	} catch (err) {
		console.error(`refusing to release: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
