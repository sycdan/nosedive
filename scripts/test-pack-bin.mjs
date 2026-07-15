import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const npmExecPath = process.env.npm_execpath;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
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

try {
  const help = runNpm(["exec", "--yes", "--package", `./${packed.filename}`, "-c", "nosedive --help"]);
  assert.match(help.stdout, /Usage: nosedive <command>/);
  assert.match(help.stdout, /dump-backlog/);
  assert.match(help.stdout, /pitch/);
} finally {
  rmSync(packed.filename, { force: true });
}
