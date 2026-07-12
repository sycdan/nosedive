import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cli = join(root, "dist", "nosedive.js");
const tmp = mkdtempSync(join(tmpdir(), "nosedive-test-"));
const gitLocalEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
];

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function runTool(command, args, cwd) {
  const env = { ...process.env };
  for (const key of gitLocalEnvKeys) delete env[key];
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertContainsPath(text, path) {
  assert.match(text, new RegExp(escapeRegExp(path)));
}

try {
  const version = run(["version"], root);
  assertOk(version, "version command failed");
  assert.match(version.stdout.trim(), /^(\d+\.\d+\.\d+(?:-\d+)?|0\.0\.0-dev)$/);

  const bridge = join(tmp, "bridge");
  mkdirSync(join(bridge, "workspace", "writable", "app"), { recursive: true });
  mkdirSync(join(bridge, "workspace", "readonly", "app"), { recursive: true });
  mkdirSync(join(bridge, "backlog", "yaml-frontmatter"), { recursive: true });
  mkdirSync(join(bridge, "backlog", "other-effort"), { recursive: true });
  mkdirSync(join(bridge, "kb"), { recursive: true });

  const writableRoot = join(bridge, "workspace", "writable");
  const readonlyRoot = join(bridge, "workspace", "readonly");
  const bridgeExclude = join(bridge, ".git", "info", "exclude");
  const writableExclude = join(writableRoot, ".git", "info", "exclude");
  const readonlyExclude = join(readonlyRoot, ".git", "info", "exclude");

  runTool("git", ["init"], bridge);
  runTool("git", ["init"], writableRoot);
  runTool("git", ["init"], readonlyRoot);
  write(bridgeExclude, "# user bridge exclude\n*.bridge-local\n");
  write(writableExclude, "# user writable exclude\n*.writable-local\n");
  write(readonlyExclude, "# user readonly exclude\n*.readonly-local\n");
  write(join(writableRoot, "CLAUDE.md"), "# Tracked local instructions\n");
  runTool("git", ["add", "CLAUDE.md"], writableRoot);
  runTool("git", ["-c", "user.name=Nosedive Test", "-c", "user.email=nosedive@example.invalid", "commit", "-m", "Track CLAUDE"], writableRoot);

  write(
    join(bridge, ".nosediverc"),
    `workspace: ./workspace
backlog: ./backlog
kb: ./kb
current:
  effort: yaml-frontmatter/YamlFrontmatter.md
`,
  );
  write(
    join(bridge, "backlog", "yaml-frontmatter", "YamlFrontmatter.md"),
    `---
phase: building
gist: "Exercise valid YAML: quoted effort gist"
repos:
  - repo-writable
  - repo-readonly:ro
---

# YAML frontmatter

Build the YAML-aware workspace work order.
`,
  );
  write(
    join(bridge, "backlog", "other-effort", "OtherEffort.md"),
    `---
phase: framing
gist: "Another open effort: visible in verbose backlog output."
---

# Other effort
`,
  );
  write(
    join(bridge, "kb", "repo-writable.md"),
    `---
kind: repo
id: repo-writable
name: writable
gist: "Writable repo: quoted gist"
meta:
  path: workspace/writable
---
`,
  );
  write(
    join(bridge, "kb", "repo-readonly.md"),
    `---
kind: repo
id: repo-readonly
name: readonly
gist: "Read-only repo: quoted gist"
meta:
  path: workspace/readonly
---
`,
  );
  write(
    join(bridge, "kb", "convention.md"),
    `---
kind: convention
id: convention-doc
name: convention.test
gist: "Quoted gist: colon, \\"quotes\\", and \`backticks\` survive YAML parsing."
scopes:
  - repo-writable
  - repo-readonly/app:gist
---

# Convention body
`,
  );
  write(
    join(bridge, "kb", "foundation.md"),
    `---
kind: foundation
id: foundation-doc
name: foundation.test
gist: "Foundation gist: body render uses markdown body."
scopes:
  - repo-writable/app:body
---

# Foundation Body

Body rendered from valid YAML frontmatter.
`,
  );

  const dryRun = run(["apply", "--dry-run"], bridge);
  assertOk(dryRun, "apply --dry-run failed");
  assert.match(dryRun.stdout, /read-only workspace\/readonly \(repo-readonly\)/);
  assert.match(dryRun.stdout, /convention\.md :gist/);
  assert.match(dryRun.stdout, /foundation\.md :body scope=app/);
  assert.match(dryRun.stdout, /No files written\./);
  assert.doesNotMatch(readFileSync(bridgeExclude, "utf8"), /BEGIN nosedive-managed/);

  const verboseBacklog = run(["dump-backlog", "--verbose"], bridge);
  assertOk(verboseBacklog, "dump-backlog --verbose failed");
  assertContainsPath(verboseBacklog.stdout, join(bridge, "backlog", "yaml-frontmatter", "YamlFrontmatter.md"));
  assertContainsPath(verboseBacklog.stdout, join(bridge, "backlog", "other-effort", "OtherEffort.md"));

  const apply = run(["apply"], bridge);
  assertOk(apply, "apply failed");
  assert.match(apply.stdout, /tracked generated file marked skip-worktree: .*CLAUDE\.md/);
  assert.equal(existsSync(join(bridge, "workspace", "CLAUDE.md")), true);
  assert.equal(existsSync(join(bridge, "workspace", "writable", "CLAUDE.md")), true);
  assert.equal(existsSync(join(bridge, "workspace", "readonly", "app", "CLAUDE.md")), true);

  const workspaceDoc = readFileSync(join(bridge, "workspace", "CLAUDE.md"), "utf8");
  assert.match(workspaceDoc, /^<!-- CLAUDE\.md: Generated by nosedive, do not edit by hand\. -->/);
  assert.doesNotMatch(workspaceDoc, /# Agent Instructions/);
  assert.doesNotMatch(workspaceDoc, /Generated by nosedive\. Do not edit by hand\./);
  assert.match(workspaceDoc, /# YAML frontmatter/);
  assert.match(workspaceDoc, /Build the YAML-aware workspace work order\./);
  assert.doesNotMatch(workspaceDoc, /Bridge:/);
  assert.doesNotMatch(workspaceDoc, /Effort:/);
  assertContainsPath(workspaceDoc, join(bridge, "workspace", "writable"));
  assertContainsPath(workspaceDoc, join(bridge, "workspace", "readonly"));
  assert.match(workspaceDoc, /Only the paths listed above are part of this effort\. Do not inspect or edit other directories unless the user explicitly expands the effort\./);
  assert.doesNotMatch(workspaceDoc, /other workspace directories/);
  assertContainsPath(workspaceDoc, join(bridge, "backlog", "yaml-frontmatter", "YamlFrontmatter.md"));
  assertContainsPath(workspaceDoc, join(bridge, "backlog", "other-effort", "OtherEffort.md"));

  const writableDoc = readFileSync(join(bridge, "workspace", "writable", "CLAUDE.md"), "utf8");
  assert.match(writableDoc, /^<!-- CLAUDE\.md: Generated by nosedive, do not edit by hand\. -->/);
  assert.doesNotMatch(writableDoc, /Target:/);
  assert.match(writableDoc, /Quoted gist: colon, "quotes", and `backticks` survive YAML parsing\./);
  const writableAgentsDoc = readFileSync(join(bridge, "workspace", "writable", "AGENTS.md"), "utf8");
  assert.match(writableAgentsDoc, /^<!-- AGENTS\.md: Generated by nosedive, do not edit by hand\. -->/);

  const bodyDoc = readFileSync(join(bridge, "workspace", "writable", "app", "CLAUDE.md"), "utf8");
  assert.match(bodyDoc, /# Foundation Body/);
  assert.match(bodyDoc, /Body rendered from valid YAML frontmatter\./);

  const readOnlyDoc = readFileSync(join(bridge, "workspace", "readonly", "app", "CLAUDE.md"), "utf8");
  assert.match(readOnlyDoc, /Read-only For This Effort/);

  for (const [label, excludePath] of [
    ["bridge", bridgeExclude],
    ["writable", writableExclude],
    ["readonly", readonlyExclude],
  ]) {
    const excludeText = readFileSync(excludePath, "utf8");
    assert.match(excludeText, new RegExp(`# user ${label} exclude`));
    assert.match(excludeText, /# BEGIN nosedive-managed exclude/);
    assert.match(excludeText, /# kb: 019f5651-5539-76f5-b6bd-351d300194eb/);
    assert.match(excludeText, /# owner: nosedive apply/);
    assert.match(excludeText, /^CLAUDE\.md$/m);
    assert.match(excludeText, /^AGENTS\.md$/m);
    assert.doesNotMatch(excludeText, /^\/CLAUDE\.md$/m);
    assert.match(excludeText, /# END nosedive-managed exclude/);
  }

  assert.match(runTool("git", ["-C", writableRoot, "ls-files", "-v", "CLAUDE.md"], root).stdout, /^S /);
  assertOk(runTool("git", ["check-ignore", "app/CLAUDE.md"], writableRoot), "nested CLAUDE.md should be ignored by bare exclude pattern");
  assertOk(runTool("git", ["check-ignore", "app/AGENTS.md"], readonlyRoot), "nested AGENTS.md should be ignored by bare exclude pattern");

  const activeBridge = join(tmp, "active-bridge");
  mkdirSync(join(activeBridge, "kb"), { recursive: true });
  write(
    join(activeBridge, ".nosediverc"),
    `kb: ./kb
`,
  );
  write(
    join(activeBridge, "kb", "active-foundation.md"),
    `---
kind: foundation
id: active-foundation
name: active-foundation
gist: "Active foundation docs render from kb-only config."
---

# Active Foundation

Bridge foundation body renders without a scope.
`,
  );
  write(
    join(activeBridge, "kb", "active-convention.md"),
    `---
kind: convention
id: active-convention
name: active.test
gist: "Scoped convention should not render from kb-only config."
scopes:
  - repo-active
---

# Active convention body
`,
  );

  const activeDryRun = run(["apply", "--dry-run"], activeBridge);
  assertOk(activeDryRun, "kb-only apply --dry-run failed");
  assert.match(activeDryRun.stdout, /Workspace: \(not configured\)/);
  assert.match(activeDryRun.stdout, /Effort:    \(not configured\)/);
  assert.match(activeDryRun.stdout, /Bridge docs:/);
  assert.match(activeDryRun.stdout, /active-foundation\.md :body/);
  assert.doesNotMatch(activeDryRun.stdout, /active-convention\.md :gist/);

  const activeApply = run(["apply"], activeBridge);
  assertOk(activeApply, "kb-only apply failed");
  assert.equal(existsSync(join(activeBridge, "CLAUDE.md")), true);
  assert.equal(existsSync(join(activeBridge, "AGENTS.md")), true);
  const activeDoc = readFileSync(join(activeBridge, "CLAUDE.md"), "utf8");
  assert.match(activeDoc, /^<!-- CLAUDE\.md: Generated by nosedive, do not edit by hand\. -->/);
  assert.doesNotMatch(activeDoc, /# Agent Instructions/);
  assert.doesNotMatch(activeDoc, /Target:/);
  assert.match(activeDoc, /# Active Foundation/);
  assert.match(activeDoc, /Bridge foundation body renders without a scope\./);
  assert.doesNotMatch(activeDoc, /Scoped convention should not render from kb-only config\./);
  assert.equal(existsSync(join(activeBridge, "workspace", "CLAUDE.md")), false);

  write(
    join(bridge, "kb", "bad.md"),
    `---
kind: convention
id: bad-doc
name: bad
gist: "unterminated
---
`,
  );

  const invalid = run(["apply", "--dry-run"], bridge);
  assert.notEqual(invalid.status, 0, "invalid YAML unexpectedly succeeded");
  assert.match(invalid.stderr, /invalid YAML in frontmatter in .*bad\.md/);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
