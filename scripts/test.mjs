import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const cli = join(root, "dist", "nosedive.js");
const tmp = mkdtempSync(join(tmpdir(), "nosedive-test-"));

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

  const verboseBacklog = run(["dump-backlog", "--verbose"], bridge);
  assertOk(verboseBacklog, "dump-backlog --verbose failed");
  assertContainsPath(verboseBacklog.stdout, join(bridge, "backlog", "yaml-frontmatter", "YamlFrontmatter.md"));
  assertContainsPath(verboseBacklog.stdout, join(bridge, "backlog", "other-effort", "OtherEffort.md"));

  const apply = run(["apply"], bridge);
  assertOk(apply, "apply failed");
  assert.equal(existsSync(join(bridge, "workspace", "CLAUDE.md")), true);
  assert.equal(existsSync(join(bridge, "workspace", "writable", "CLAUDE.md")), true);
  assert.equal(existsSync(join(bridge, "workspace", "readonly", "app", "CLAUDE.md")), true);

  const workspaceDoc = readFileSync(join(bridge, "workspace", "CLAUDE.md"), "utf8");
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
  assert.match(writableDoc, /Quoted gist: colon, "quotes", and `backticks` survive YAML parsing\./);

  const bodyDoc = readFileSync(join(bridge, "workspace", "writable", "app", "CLAUDE.md"), "utf8");
  assert.match(bodyDoc, /# Foundation Body/);
  assert.match(bodyDoc, /Body rendered from valid YAML frontmatter\./);

  const readOnlyDoc = readFileSync(join(bridge, "workspace", "readonly", "app", "CLAUDE.md"), "utf8");
  assert.match(readOnlyDoc, /Read-only For This Effort/);

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
