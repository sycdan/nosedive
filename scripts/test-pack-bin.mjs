import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const npmExecPath = process.env.npm_execpath;

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
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
try {
	const help = runNpm(["exec", "--yes", "--package", packedPath, "-c", "nosedive --help"]);
	assert.match(help.stdout, /Usage: nosedive <command>/);
	assert.match(help.stdout, /dump-backlog/);
	assert.match(help.stdout, /pitch/);
	assert.match(help.stdout, /add-repo/);

	run("git", ["init", "-b", "main"], seedBridge);
	run("git", ["config", "user.name", "Packed Pilot"], seedBridge);
	run("git", ["config", "user.email", "packed@example.invalid"], seedBridge);
	const seed = runPackedNpm(
		["exec", "--yes", "--package", packedPath, "-c", "nosedive seed --headless"],
		seedBridge,
	);
	assert.match(seed.stdout, /Wrote \.nosedive[\\/]config\.yaml/);
	assert.doesNotMatch(seed.stdout, /\.nosedive\.local\.yaml/);
	assert.doesNotMatch(seed.stdout, /Seeded .*foundation docs/);
	assert.doesNotMatch(seed.stdout, /migration doc/);
	// A fresh seed writes exactly one kb doc: the backlog memo `backlog:` names.
	const seededKb = readdirSync(join(seedBridge, "kb"));
	assert.equal(seededKb.length, 1, `unexpected seeded kb contents: ${seededKb.join(", ")}`);
	assert.match(
		readFileSync(join(seedBridge, "kb", seededKb[0]), "utf8"),
		/^kind: memo$/m,
		"the one seeded kb doc should be the backlog memo",
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
}
