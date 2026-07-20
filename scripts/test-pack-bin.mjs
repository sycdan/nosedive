import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

  for (let start = stdout.indexOf("["); start !== -1 && start < end; start = stdout.indexOf("[", start + 1)) {
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
assert.equal(typeof packed?.filename, "string", `npm pack output did not include a filename:\n${pack.stdout}`);
const packedPath = resolve(packed.filename);
const initBridge = mkdtempSync(join(tmpdir(), "nosedive-pack-init-"));
const expectedFoundationDocs = [
  "00000000-0000-7434-9b1d-72a777ca61f7.md",
  "0000000f-4240-7a62-8f61-a85b4c364560.md",
  "0000001e-8480-79d6-8e3d-00222452c904.md",
  "0000002d-c6c0-7354-a306-7624c2db8283.md",
];

try {
  const help = runNpm(["exec", "--yes", "--package", packedPath, "-c", "nosedive --help"]);
  assert.match(help.stdout, /Usage: nosedive <command>/);
  assert.match(help.stdout, /dump-backlog/);
  assert.match(help.stdout, /pitch/);
  assert.match(help.stdout, /add-repo/);

  run("git", ["init", "-b", "main"], initBridge);
  const init = runPackedNpm(["exec", "--yes", "--package", packedPath, "-c", "nosedive init --headless"], initBridge);
  assert.match(init.stdout, /Wrote \.nosediverc/);
  assert.match(init.stdout, new RegExp(`Seeded ${expectedFoundationDocs.length} foundation docs into \\.\\/kb`));
  const seededFilenames = readdirSync(join(initBridge, "kb")).filter((filename) => filename.endsWith(".md")).sort();
  assert.deepEqual(seededFilenames, expectedFoundationDocs);
  const seededDocs = seededFilenames
    .filter((filename) => filename.endsWith(".md"))
    .map((filename) => readFileSync(join(initBridge, "kb", filename), "utf8"));
  assert.equal(
    seededDocs.some((content) => /^kind: foundation$/m.test(content)),
    true,
    `packed init did not seed any foundation docs:\n${init.stdout}\n${init.stderr}`,
  );
} finally {
  rmSync(packed.filename, { force: true });
  rmSync(initBridge, { recursive: true, force: true });
}
