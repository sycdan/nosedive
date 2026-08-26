import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { git } from "./check-publish-finalization.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_TRAILER = "Nosedive-Publish-Source";
const VERSION_TRAILER = "Nosedive-Publish-Version";

/** Everything a finalization is allowed to touch. Anything else is somebody's work. */
const FINALIZED_PATHS = ["README.md", "package.json", "package-lock.json"];

/**
 * The commit is made by the pipeline, not by whoever pushed, and the runner has
 * no global Git identity. Naming it here rather than configuring the checkout
 * keeps the author of a finalization a property of the finalization.
 */
const IDENTITY = [
	"-c",
	"user.name=github-actions[bot]",
	"-c",
	"user.email=41898282+github-actions[bot]@users.noreply.github.com",
];

function trackedChanges(repo) {
	return git(repo, ["diff", "--name-only", "HEAD"])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function declaredVersions(repo) {
	const read = (path) => JSON.parse(readFileSync(join(repo, path), "utf8"));
	const lock = read("package-lock.json");
	return [
		["package.json", read("package.json").version],
		["package-lock.json", lock.version],
		["package-lock.json root package", lock.packages?.[""]?.version],
	];
}

/**
 * Commits the release candidate's regenerated surfaces and stamped version as
 * the one managed finalization of `source`, and refuses rather than committing
 * anything a publish is not allowed to change.
 *
 * The refusals matter more than the commit. This runs on a tree that generators
 * and `npm version` have already rewritten, so anything else that moved got
 * there by a build step editing tracked source -- which would ship under a
 * version nobody reviewed, and would leave main carrying a change no pull
 * request made. Failing the release is the cheap outcome.
 *
 * What it writes is exactly what `checkPublishFinalization` reads back, so a
 * rerun of an interrupted publish can recognize its own work.
 *
 * @see kb/01a03e18-7fe4-7f5c-93f3-64825b38599f.md
 */
export function finalizePublish({ repo = root, source, version }) {
	const head = git(repo, ["rev-parse", "--verify", "HEAD"]).trim();
	const sourceSha = git(repo, ["rev-parse", "--verify", `${source}^{commit}`]).trim();
	if (head !== sourceSha) {
		throw new Error(`HEAD is ${head}, not the release candidate ${sourceSha}`);
	}

	const changed = trackedChanges(repo);
	const stray = changed.filter((path) => !FINALIZED_PATHS.includes(path));
	if (stray.length > 0) {
		throw new Error(`${stray.join(", ")} changed, outside ${FINALIZED_PATHS.join(", ")}`);
	}
	for (const [label, declared] of declaredVersions(repo)) {
		if (declared !== version) throw new Error(`${label} is ${declared}, not ${version}`);
	}

	const readmeChanged = changed.includes("README.md");
	const subject = `publish(nosedive@${version}): README surfaces ${
		readmeChanged ? "updated" : "unchanged"
	}`;
	// One -m for both trailers, because Git reads only the last paragraph of a
	// message as its trailer block; a paragraph each would leave the first one
	// unparseable and the finalization unrecognizable to its own rerun.
	const trailers = `${SOURCE_TRAILER}: ${sourceSha}\n${VERSION_TRAILER}: ${version}`;
	git(repo, ["add", "--", ...changed]);
	git(repo, [...IDENTITY, "commit", "-m", subject, "-m", trailers]);

	return { commit: git(repo, ["rev-parse", "HEAD"]).trim(), version, readmeChanged };
}

function optionValue(args, name) {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const source = optionValue(args, "--source");
	const version = optionValue(args, "--version");
	if (!source || !version) {
		console.error("usage: node scripts/finalize-publish.mjs --source <sha> --version <version>");
		process.exit(2);
	}
	try {
		const result = finalizePublish({ source, version });
		console.log(`finalization=${result.commit}`);
		console.log(`readme=${result.readmeChanged}`);
	} catch (err) {
		console.error(`refusing to finalize: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
