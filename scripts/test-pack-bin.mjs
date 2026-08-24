import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const npmExecPath = process.env.npm_execpath;

/**
 * Mirrors `GIT_LOCAL_ENV_KEYS` in src/lib/constants.ts.
 *
 * This script runs `git init` in a temporary directory and then runs the packed
 * CLI there. Git sets these when it invokes a hook, so inheriting them makes
 * every child resolve the *outer* repository instead of the temporary one --
 * which surfaces as the packed `seed` refusing with "must be run inside a git
 * repository", from inside a directory that plainly is one. That made this
 * script pass when run by hand and fail when run from `.githooks/pre-push`.
 */
const GIT_LOCAL_ENV_KEYS = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_WORK_TREE",
];

function cleanEnv() {
	const env = { ...process.env };
	for (const key of GIT_LOCAL_ENV_KEYS) delete env[key];
	return env;
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", env: cleanEnv() });
	assert.equal(
		result.status,
		0,
		`${command} ${args.join(" ")} failed\nerror:\n${result.error?.message ?? "(none)"}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
	);
	return result;
}

function runNpm(args) {
	if (npmExecPath) return run(process.execPath, [npmExecPath, ...args]);
	return run(process.platform === "win32" ? "npm.cmd" : "npm", args);
}

function runPackedNpm(args, cwd) {
	if (npmExecPath) return run(process.execPath, [npmExecPath, ...args], cwd);
	return run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd);
}

function parsePackOutput(stdout) {
	const end = stdout.lastIndexOf("]");
	assert.notEqual(end, -1, `npm pack --json did not print JSON:\n${stdout}`);

	for (
		let start = stdout.indexOf("[");
		start !== -1 && start < end;
		start = stdout.indexOf("[", start + 1)
	) {
		try {
			return JSON.parse(stdout.slice(start, end + 1));
		} catch {
			// Lifecycle logs may contain ANSI escapes before npm's JSON.
		}
	}

	assert.fail(`npm pack --json did not print parseable JSON:\n${stdout}`);
}

const pack = runNpm(["pack", "--json"]);
const [packed] = parsePackOutput(pack.stdout);
assert.equal(
	typeof packed?.filename,
	"string",
	`npm pack output did not include a filename:\n${pack.stdout}`,
);
const packedPath = resolve(packed.filename);
const seedBridge = mkdtempSync(join(tmpdir(), "nosedive-pack-seed-"));
const seedOrigin = mkdtempSync(join(tmpdir(), "nosedive-pack-origin-"));
try {
	const help = runNpm(["exec", "--yes", "--package", packedPath, "-c", "nosedive --help"]);
	assert.match(help.stdout, /Usage: nosedive <command>/);
	assert.match(help.stdout, /dump-backlog/);
	assert.match(help.stdout, /record.feat/);
	assert.match(help.stdout, /add-repo/);

	run("git", ["init", "-b", "main"], seedBridge);
	run("git", ["init", "--bare", "-b", "main"], seedOrigin);
	run("git", ["config", "user.name", "Packed Pilot"], seedBridge);
	run("git", ["config", "user.email", "packed@example.invalid"], seedBridge);
	// A local bare origin keeps the packed install proof offline while exercising
	// seed's first publish.
	run("git", ["remote", "add", "origin", seedOrigin], seedBridge);
	const seed = runPackedNpm(
		["exec", "--yes", "--package", packedPath, "-c", "nosedive seed --headless --file AGENTS.md"],
		seedBridge,
	);
	assert.match(seed.stdout, /Wrote \.nosedive[\\/]config\.yaml/);
	assert.match(seed.stdout, /Wrote AGENTS\.md/);
	// The packed bin resolves its own version and command surface from the
	// installed package, which only a real install exercises.
	const seededInstructions = readFileSync(join(seedBridge, "AGENTS.md"), "utf8");
	// Mirrors `SURFACE_STAMP_PATTERN` in src/lib/packageBacklog.ts.
	const stamp =
		/^<!-- nosedive v=(\S+?)(?: commit=([0-9a-f]{7,40}))? surface=([0-9a-f]{8}) -->$/m.exec(
			seededInstructions,
		);
	assert.ok(stamp, `seeded AGENTS.md carries no surface stamp:\n${seededInstructions}`);
	// A packed install lives under some project's node_modules and is not its own
	// repository, so it has no commit to stamp -- and asking git there would
	// answer about the project. This is the only proof of that side.
	assert.equal(stamp[2], undefined, `a packed install stamped a commit: ${stamp[0]}`);
	assert.match(seededInstructions, /^Usage: nosedive <command>$/m);
	assert.match(seededInstructions, /^<!-- END nosedive managed instructions -->$/m);
	assert.doesNotMatch(seed.stdout, /\.nosedive\.local\.yaml/);
	assert.doesNotMatch(seed.stdout, /Seeded .*foundation docs/);
	assert.doesNotMatch(seed.stdout, /migration doc/);
	// A fresh seed writes exactly two kb docs: the backlog memo `backlog:` names,
	// and the bridge's own `kind: repo` doc, so a new pilot has something to
	// scope a dive to without first finding `record.repo`.
	const seededKb = readdirSync(join(seedBridge, "kb"));
	assert.equal(seededKb.length, 2, `unexpected seeded kb contents: ${seededKb.join(", ")}`);
	const seededKinds = seededKb
		.map((entry) => /^kind: (\w+)$/m.exec(readFileSync(join(seedBridge, "kb", entry), "utf8"))?.[1])
		.sort();
	assert.deepEqual(
		seededKinds,
		["memo", "repo"],
		"seed should write one backlog memo and one repo",
	);
	assert.equal(
		readFileSync(join(seedBridge, ".nosedive", ".gitignore"), "utf8"),
		["cache/", "migration-backups/", ""].join("\n"),
	);
	assert.equal(existsSync(join(seedBridge, ".nosedive.local.yaml")), false);
	assert.doesNotMatch(
		readFileSync(join(seedBridge, ".git", "info", "exclude"), "utf8"),
		/^\.nosedive\.local\.yaml$/m,
	);
	const whoami = runPackedNpm(
		["exec", "--yes", "--package", packedPath, "-c", "nosedive whoami"],
		seedBridge,
	);
	assert.equal(
		whoami.stdout,
		"nosedive-pilot-name: Packed Pilot\nnosedive-pilot-email: packed@example.invalid\n",
	);
} finally {
	rmSync(packed.filename, { force: true });
	rmSync(seedBridge, { recursive: true, force: true });
	rmSync(seedOrigin, { recursive: true, force: true });
}
