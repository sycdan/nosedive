import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TIMESTAMPED_VERSION } from "./version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_TRAILER = "Nosedive-Publish-Source";
const VERSION_TRAILER = "Nosedive-Publish-Version";

/** Everything a finalization is allowed to touch. Anything else is somebody's work. */
const FINALIZED_PATHS = ["README.md", "package.json", "package-lock.json"];

/** Both README surface generators, each of which supports `--check`. */
const README_GENERATORS = [
	"scripts/update-readme-command-surface.mjs",
	"scripts/update-readme-faq.mjs",
];

/**
 * A child of this process sees no inherited git state. A suite or a hook that
 * exports GIT_DIR would otherwise redirect every call below at its own
 * repository instead of the one named by `repo`.
 */
function cleanEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	return env;
}

export function git(repo, args) {
	const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: cleanEnv() });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result.stdout;
}

function failure(condition, detail) {
	return { ok: false, condition, detail };
}

function trailer(repo, commit, key) {
	const raw = git(repo, ["show", "-s", `--format=%(trailers:key=${key},valueonly)`, commit]);
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)[0];
}

function fileAt(repo, commit, path) {
	return JSON.parse(git(repo, ["show", `${commit}:${path}`]));
}

/**
 * The generators resolve their own repository from where they sit, so the tree
 * has to be checked out to run them against it -- and it has to be checked out
 * inside the repository, because node finds their `yaml` import by walking up
 * from the script file to the repository's node_modules.
 */
function staleReadmeSurface(repo, commit) {
	const worktree = join(repo, `.publish-finalization-check-${process.pid}`);
	git(repo, ["worktree", "add", "--detach", worktree, commit]);
	try {
		for (const generator of README_GENERATORS) {
			const script = join(worktree, generator);
			if (!existsSync(script)) return failure("readme-surface", `${generator} is missing`);
			const result = spawnSync(process.execPath, [script, "--check"], {
				cwd: worktree,
				encoding: "utf8",
				env: cleanEnv(),
			});
			if (result.error) throw result.error;
			if (result.status !== 0) {
				const said = (result.stderr || result.stdout).trim();
				return failure("readme-surface", `${generator} --check failed: ${said}`);
			}
		}
		return undefined;
	} finally {
		git(repo, ["worktree", "remove", "--force", worktree]);
	}
}

/**
 * Decides whether `commit` is a managed publish finalization of `source`, and
 * says which condition it failed. A stuck release needs the reason, not a false.
 */
export function checkPublishFinalization({ repo = root, commit, source }) {
	const commitSha = git(repo, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
	const sourceSha = git(repo, ["rev-parse", "--verify", `${source}^{commit}`]).trim();

	const parents = git(repo, ["rev-list", "--parents", "-n", "1", commitSha])
		.trim()
		.split(" ")
		.slice(1);
	if (parents.length !== 1 || parents[0] !== sourceSha) {
		return failure("parent", `expected parent ${sourceSha}, found ${parents.join(", ") || "none"}`);
	}

	const declaredSource = trailer(repo, commitSha, SOURCE_TRAILER);
	if (!declaredSource) return failure("source-trailer", `commit carries no ${SOURCE_TRAILER}`);
	if (declaredSource !== sourceSha) {
		return failure("source-trailer", `${SOURCE_TRAILER} names ${declaredSource}, not ${sourceSha}`);
	}

	const version = trailer(repo, commitSha, VERSION_TRAILER);
	if (!version) return failure("version-trailer", `commit carries no ${VERSION_TRAILER}`);
	if (!TIMESTAMPED_VERSION.test(version)) {
		return failure(
			"version-trailer",
			`${VERSION_TRAILER} is ${version}, which is not a timestamped dev version (yyyy.m.d-<utc millis>)`,
		);
	}

	const lock = fileAt(repo, commitSha, "package-lock.json");
	const declaredVersions = [
		["package.json", fileAt(repo, commitSha, "package.json").version],
		["package-lock.json", lock.version],
		["package-lock.json root package", lock.packages?.[""]?.version],
	];
	for (const [label, declared] of declaredVersions) {
		if (declared !== version) {
			return failure(
				"package-version",
				`${label} is ${declared}, but ${VERSION_TRAILER} is ${version}`,
			);
		}
	}

	const changed = git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const stray = changed.filter((path) => !FINALIZED_PATHS.includes(path));
	if (stray.length > 0) {
		return failure(
			"changed-paths",
			`changed ${stray.join(", ")}, outside ${FINALIZED_PATHS.join(", ")}`,
		);
	}

	const stale = staleReadmeSurface(repo, commitSha);
	if (stale) return stale;

	return { ok: true, commit: commitSha, source: sourceSha, version };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [commit, source] = process.argv.slice(2);
	if (!commit || !source) {
		console.error("usage: node scripts/check-publish-finalization.mjs <commit> <source-sha>");
		process.exit(2);
	}
	const result = checkPublishFinalization({ commit, source });
	if (result.ok) {
		console.log(`${result.commit} finalizes ${result.source} at ${result.version}`);
	} else {
		console.error(`publish finalization check failed (${result.condition}): ${result.detail}`);
		process.exit(1);
	}
}
