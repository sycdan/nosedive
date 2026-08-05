import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cli = join(root, "dist", "cli.js");
export const lib = join(root, "dist", "nosedive.js");
export const libUrl = pathToFileURL(lib).href;

export const packageFoundationDocs = [
	"00000000-0000-7434-9b1d-72a777ca61f7.md",
	"0000000f-4240-7a62-8f61-a85b4c364560.md",
	"0000001e-8480-79d6-8e3d-00222452c904.md",
	"0000002d-c6c0-7354-a306-7624c2db8283.md",
	"0000004c-4b40-7ee6-a8de-1f3b50de9a0b.md",
];
export const packageNonFoundationDoc = "00cb3908-d040-795e-ae14-89cd1aeeaaf8.md";
export const packageMigrationDoc = "019f916b-f800-723d-b096-07d4300ff28a.md";
export const packageMigrationScript = "019f916b-f801-7f38-b893-78904aa97b69.mjs";
export const handoffRunbookId = "019f9f95-750a-7b26-a53e-6c277e8f148f";

const gitLocalEnvKeys = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_WORK_TREE",
];

/**
 * One scratch root per test file, removed when that file's tests finish. Files
 * run in separate processes under `node --test`, so sharing a single root
 * across the suite would make cleanup racy.
 */
export function createTmp(label) {
	const dir = mkdtempSync(join(tmpdir(), `nosedive-${label}-`));
	after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Commands that must run with no bridge in scope have to run somewhere outside
 * one. The repo root is not safe for that: bridge lookup walks upward, so a
 * checkout nested inside somebody's bridge would resolve that bridge and route
 * through command docs instead of builtins.
 */
export function createNoBridge(tmp) {
	const dir = join(tmp, "no-bridge");
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function write(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

/**
 * `git am` creates real commits, so it needs a committer identity -- unlike
 * `gitCommit`'s `-c` flags, this has to reach the CLI's own internal git
 * calls (e.g. jump's `git am`), which run with no identity override of their
 * own since production expects the pilot's real config. Set via env rather
 * than repo-local config so it survives the dehydrate/re-clone cycle jump
 * exercises, and so fixtures do not depend on the runner's global git config.
 */
const testIdentityEnv = {
	GIT_AUTHOR_NAME: "Nosedive Test",
	GIT_AUTHOR_EMAIL: "nosedive@example.invalid",
	GIT_COMMITTER_NAME: "Nosedive Test",
	GIT_COMMITTER_EMAIL: "nosedive@example.invalid",
};

/**
 * Runs the CLI with the ambient git environment stripped, the same way runGit
 * and runTool do. Without this, a suite invoked from inside a git hook
 * inherits GIT_DIR and friends, and every command the CLI shells out to reads
 * the hook's repository instead of the fixture the test just built.
 */
export function run(args, cwd, input) {
	const env = { ...process.env, ...testIdentityEnv };
	for (const key of gitLocalEnvKeys) delete env[key];
	return spawnSync(process.execPath, [cli, ...args], {
		cwd,
		encoding: "utf8",
		input,
		env,
	});
}

const gitSafeBareConfigArgs = ["-c", "safe.bareRepository=all"];

export function runGit(args, cwd, { expectOk = true } = {}) {
	const env = { ...process.env };
	for (const key of gitLocalEnvKeys) delete env[key];
	const result = spawnSync("git", [...gitSafeBareConfigArgs, ...args], {
		cwd,
		encoding: "utf8",
		env,
	});
	if (expectOk) {
		assert.equal(
			result.status,
			0,
			`git ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return result;
}

export function runTool(command, args, cwd) {
	if (command === "git") return runGit(args, cwd);
	const env = { ...process.env };
	for (const key of gitLocalEnvKeys) delete env[key];
	const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
	return result;
}

export function runGitUnchecked(args, cwd) {
	return runGit(args, cwd, { expectOk: false });
}

export function assertOk(result, label) {
	assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

export function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertContainsPath(text, path) {
	assert.match(text, new RegExp(escapeRegExp(path)));
}

export function gitCommonDir(cwd) {
	const raw = runTool("git", ["rev-parse", "--git-common-dir"], cwd).stdout.trim();
	return realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

export function assertGeneratedFrontmatter(text, filename, fields = []) {
	const expected = [
		"---",
		`generated-by: "nosedive"`,
		`generated-file: "${filename}"`,
		"do-not-edit: true",
		`gist: "Generated by nosedive from kb; do not edit by hand."`,
		...fields,
		"---",
		"",
	].join("\n");
	assert.equal(
		text.startsWith(expected),
		true,
		`expected generated frontmatter:\n${expected}\nactual start:\n${text.slice(0, 300)}`,
	);
}

const testIdentity = ["-c", "user.name=Nosedive Test", "-c", "user.email=nosedive@example.invalid"];

/** `git commit` with a fixed identity, so fixtures do not depend on the developer's git config. */
export function gitCommit(cwd, message) {
	runTool("git", [...testIdentity, "commit", "-m", message], cwd);
}

/**
 * A bridge at the current compatibility level. Fixtures want an L1 bridge
 * unless they are specifically exercising migration, and hand-writing the
 * split config in every test invites drift when its shape changes.
 */
export function writeBridgeConfig(
	bridgeDir,
	{ workspace = "./workspace", kb = "./kb", backlog } = {},
) {
	const lines = ["compatibility-level: 1", `workspace: ${workspace}`, `kb: ${kb}`];
	if (backlog) lines.push(`backlog: ${backlog}`);
	lines.push("");
	write(join(bridgeDir, ".nosedive", "config.yaml"), lines.join("\n"));
}

/** A git-backed bridge directory at the current compatibility level. */
export function createBridge(tmp, name, options) {
	const bridgeDir = join(tmp, name);
	mkdirSync(bridgeDir, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridgeDir);
	writeBridgeConfig(bridgeDir, options);
	return bridgeDir;
}
