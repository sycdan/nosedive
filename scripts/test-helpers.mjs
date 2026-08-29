import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cli = join(root, "dist", "cli.js");
/**
 * The running package version. The publish workflow stamps a real version before
 * running the suite, so a fixture that hard-codes the dev placeholder passes on
 * PR CI and fails only on publish.
 */
export const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

/** `packageVersion` escaped for use inside a regular expression. */
export const packageVersionPattern = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const lib = join(root, "dist", "nosedive.js");
export const libUrl = pathToFileURL(lib).href;

export const packageFoundationDocs = [
	"00000000-0000-7434-9b1d-72a777ca61f7.md",
	"00000000-0000-7bee-b718-0c6abe48ee4f.md",
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
export function run(args, cwd, input, cliPath = cli) {
	const env = { ...process.env, ...testIdentityEnv };
	for (const key of gitLocalEnvKeys) delete env[key];
	return spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		encoding: "utf8",
		input,
		env,
	});
}

const gitSafeBareConfigArgs = ["-c", "safe.bareRepository=all"];

export function runGit(args, cwd, { expectOk = true, env: extraEnv } = {}) {
	const env = { ...process.env, ...extraEnv };
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
	// A child that never started reports status null with undefined streams, which
	// asserts as `null !== 0` and reads exactly like a real failure. Name the
	// spawn error instead, so a missing dependency cannot pose as a broken build.
	assert.equal(
		result.error,
		undefined,
		`${command} could not start: ${result.error?.message ?? ""}`,
	);
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
	return result;
}

let cachedPosixShell;

/**
 * A POSIX shell for running hook fixtures.
 *
 * `sh` is on PATH on macOS and Linux and is not on Windows, where the only
 * `bash` may be WSL's launcher rather than a shell that understands Windows
 * paths. Git for Windows ships its own `sh` under `usr/bin`, and git is already
 * a hard dependency of every nosedive command, so deriving the shell from
 * `git --exec-path` adds no requirement a user did not already meet.
 *
 * Returns undefined when neither resolves, so a caller can skip with a stated
 * reason rather than fail obscurely.
 */
export function posixShell() {
	if (cachedPosixShell !== undefined) return cachedPosixShell || undefined;
	const onPath = spawnSync("sh", ["-c", "exit 0"], { encoding: "utf8" });
	if (!onPath.error && onPath.status === 0) {
		cachedPosixShell = "sh";
		return cachedPosixShell;
	}
	const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
	if (!execPath.error && execPath.status === 0) {
		const gitRoot = resolve(execPath.stdout.trim(), "..", "..", "..");
		for (const candidate of [
			join(gitRoot, "usr", "bin", "sh.exe"),
			join(gitRoot, "bin", "sh.exe"),
		]) {
			if (existsSync(candidate)) {
				cachedPosixShell = candidate;
				return cachedPosixShell;
			}
		}
	}
	cachedPosixShell = "";
	return undefined;
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

/**
 * `git commit` with a fixed identity, so fixtures do not depend on the
 * developer's git config.
 *
 * A staged-nothing commit is skipped rather than failed. Fixtures stage `kb`
 * after a record command to reach the state a real bridge is in, and those
 * commands commit their own documents now, so there is often nothing left --
 * the fixture is asking for a state that already holds. A fixture that needed
 * the commit still fails, downstream, on whatever it asserts about HEAD.
 */
export function gitCommit(cwd, message) {
	if (runGit(["diff", "--cached", "--quiet"], cwd, { expectOk: false }).status === 0) return;
	runTool("git", [...testIdentity, "commit", "-m", message], cwd);
}

/** `gitCommit` for a commit with no changes -- a fixture that only needs HEAD to move. */
export function gitCommitEmpty(cwd, message) {
	runTool("git", [...testIdentity, "commit", "--allow-empty", "-m", message], cwd);
}

/**
 * A bridge at the current compatibility level. Fixtures want an L1 bridge
 * unless they are specifically exercising migration, and hand-writing the
 * split config in every test invites drift when its shape changes.
 */
export function writeBridgeConfig(
	bridgeDir,
	{ workspace = "./workspace", kb = "./kb", backlog, bridge } = {},
) {
	const lines = ["compatibility-level: 2", `workspace: ${workspace}`, `kb: ${kb}`];
	if (backlog) lines.push(`backlog: ${backlog}`);
	if (bridge) lines.push(`bridge: ${bridge}`);
	lines.push("");
	write(join(bridgeDir, ".nosedive", "config.yaml"), lines.join("\n"));
}

/** A git-backed bridge directory at the current compatibility level. */
export function createBridge(tmp, name, options) {
	const bridgeDir = join(tmp, name);
	mkdirSync(bridgeDir, { recursive: true });
	runTool("git", ["init", "-b", "main"], bridgeDir);
	runTool("git", ["config", "user.name", "Nosedive Test"], bridgeDir);
	runTool("git", ["config", "user.email", "test@nosedive.invalid"], bridgeDir);
	giveOrigin(tmp, bridgeDir, name);
	writeBridgeConfig(bridgeDir, options);
	return bridgeDir;
}

// --- end-to-end fixtures ----------------------------------------------------
//
// A test that walks a whole workflow needs the same three things every time: a
// bare remote to publish to, an implementation repo with history, and a seeded
// bridge that can push. Written once here so a test reads as the workflow it is
// exercising rather than as its own setup.

/**
 * A bare `origin` already carrying `main`, for a bridge a fixture built by hand.
 * `seed` refuses a bridge with no `origin`, and trunk resolution needs that
 * remote to have a HEAD, which an empty bare repo does not.
 *
 * The base commit carries its own identity via `-c` rather than reading the
 * one on `bridgeDir`, so this can be called before a fixture configures the
 * identity it wants to assert on. Depending on that ordering passed on a
 * machine with a global `user.name` and failed on CI, which has none.
 */
export function giveOrigin(tmp, bridgeDir, name, branch = "main") {
	runTool(
		"git",
		["remote", "add", "origin", bareRepo(tmp, `${name}-origin.git`, branch)],
		bridgeDir,
	);
	runTool(
		"git",
		[
			"-c",
			"user.name=Nosedive Test",
			"-c",
			"user.email=test@nosedive.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"base",
		],
		bridgeDir,
	);
	runTool("git", ["push", "-u", "origin", branch], bridgeDir);
	runTool("git", ["remote", "set-head", "origin", branch], bridgeDir);
}

/** An empty bare repository, for use as a remote. */
export function bareRepo(tmp, name, branch = "main") {
	const path = join(tmp, name);
	mkdirSync(path, { recursive: true });
	runTool("git", ["init", "--bare", "-b", branch], path);
	return path;
}

/**
 * An implementation repo with one commit, published to a cloud and a local bare
 * remote. Returns the paths a repo doc needs plus the source checkout, which is
 * where a fixture simulates work arriving from outside the bridge.
 */
export function implRepo(tmp, name) {
	const cloud = bareRepo(tmp, `${name}-cloud.git`);
	const local = bareRepo(tmp, `${name}-local.git`);
	const source = join(tmp, `${name}-source`);
	mkdirSync(source, { recursive: true });
	runTool("git", ["init", "-b", "main"], source);
	write(join(source, "README.md"), `${name}\n`);
	runTool("git", ["add", "README.md"], source);
	gitCommit(source, `base ${name}`);
	runTool("git", ["remote", "add", "cloud", cloud], source);
	runTool("git", ["remote", "add", "local", local], source);
	runTool("git", ["push", "cloud", "main"], source);
	runTool("git", ["push", "local", "main"], source);
	return { name, cloud, local, source };
}

/** The `kind: repo` doc for an `implRepo`, hydratable from its cloud remote. */
export function writeImplRepoDoc(bridge, id, repo) {
	const posix = (path) => path.replaceAll("\\", "/");
	write(
		join(bridge, "kb", `${id}.md`),
		`---
kind: repo
id: ${id}
name: ${repo.name}
gist: "Implementation repo ${repo.name}"
meta:
  path: workspace/${repo.name}
  trunk: main
  remotes:
    cloud: ${posix(repo.cloud)}
    local: ${posix(repo.local)}
---
`,
	);
}

/**
 * A seeded bridge with an upstream, which `land` requires. Committed and pushed
 * so the bridge is in the state a pilot's would be after `seed`.
 */
export function seededBridge(tmp, name, diver) {
	const bridge = createBridge(tmp, name);
	runTool("git", ["config", "user.name", "Nosedive Test"], bridge);
	runTool("git", ["config", "user.email", diver], bridge);
	assertOk(run(["seed", "--headless"], bridge, ""), "seed failed");
	return { bridge, origin: join(tmp, `${name}-origin.git`) };
}

/** Records a feat and returns where it landed, for fixtures that then edit it. */
export function pitchFeat(bridge, gist, name) {
	const pitched = run(["record.feat", gist, "--name", name], bridge);
	assertOk(pitched, "record.feat failed");
	const featPath = join(bridge, /^Recorded (.+)$/m.exec(pitched.stdout)?.[1] ?? "");
	const text = readFileSync(featPath, "utf8");
	const id = /^id: (\S+)$/m.exec(text)?.[1];
	assert.ok(id, `recorded feat has no id:\n${text}`);
	return { featPath, featId: id, featText: text };
}

/** The dive id `record.dive` just reported. */
export function recordedDiveId(stdout) {
	const id = /^Recorded kb[\/]([0-9a-f-]{36})\.md$/m.exec(stdout)?.[1];
	assert.ok(id, `record.dive did not report a dive id:\n${stdout}`);
	return id;
}
