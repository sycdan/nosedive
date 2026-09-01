import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createTmp, libUrl, write } from "../test-helpers.mjs";

const { reconcileDocLink } = await import(libUrl);
const tmp = createTmp("reconcile-doc-link");

test("reconcileDocLink changes rel while preserving unowned YAML nodes and comments", () => {
	const targetId = "01a05ef9-5b32-7079-82a6-37deeb2512fb";
	const path = join(tmp, "feat.md");
	write(
		path,
		`---
kind: feat
id: 01a05ef9-5b32-7079-82a6-37deeb2512fa
name: preservation
gist: "Keep the pilot's keys."
links:
  # This edge has history.
  - kb/${targetId}.md:
      rel: planned.dive
      note: the pilot wrote this
      arbitrary:
        - first
        - second # This comment must survive too.
---

# Preservation
`,
	);

	reconcileDocLink(path, targetId, "jumped.dive");
	const text = readFileSync(path, "utf8");
	assert.match(
		text,
		new RegExp(
			`- kb/${targetId}\\.md:\\n      rel: jumped\\.dive\\n      note: the pilot wrote this\\n      arbitrary:\\n        - first\\n        - second # This comment must survive too\\.`,
		),
	);
	assert.match(text, /# This edge has history\./);
});
