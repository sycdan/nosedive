import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { checkPublishFinalization } from "../check-publish-finalization.mjs";
import { finalizePublish } from "../finalize-publish.mjs";
import { createTmp, runTool, write } from "../test-helpers.mjs";
import {
	commitAll,
	regenerateReadme,
	sourceRepo,
	stampVersion,
	VERSION,
} from "./fixtures/publish-repo.mjs";

const tmp = createTmp("publish-finalize");

function subject(dir) {
	return runTool("git", ["show", "-s", "--format=%s", "HEAD"], dir).stdout.trim();
}

test("what a finalization writes is what the check reads back", () => {
	const { dir, source } = sourceRepo(tmp, "round-trip");
	regenerateReadme(dir);
	stampVersion(dir, VERSION);

	const result = finalizePublish({ repo: dir, source, version: VERSION });

	assert.equal(result.readmeChanged, true);
	assert.deepEqual(checkPublishFinalization({ repo: dir, commit: result.commit, source }), {
		ok: true,
		commit: result.commit,
		source,
		version: VERSION,
	});
});

test("the subject reports whether the generated surfaces moved", () => {
	const updated = sourceRepo(tmp, "readme-updated");
	regenerateReadme(updated.dir);
	stampVersion(updated.dir, VERSION);
	finalizePublish({ repo: updated.dir, source: updated.source, version: VERSION });
	assert.equal(subject(updated.dir), `publish(nosedive@${VERSION}): README surfaces updated`);

	const unchanged = sourceRepo(tmp, "readme-unchanged");
	stampVersion(unchanged.dir, VERSION);
	finalizePublish({ repo: unchanged.dir, source: unchanged.source, version: VERSION });
	assert.equal(subject(unchanged.dir), `publish(nosedive@${VERSION}): README surfaces unchanged`);
});

test("a build step that edited tracked source fails the release instead of shipping", () => {
	const { dir, source } = sourceRepo(tmp, "stray-path");
	stampVersion(dir, VERSION);
	write(join(dir, "src", "nosedive.ts"), "export const version = 2;\n");

	assert.throws(
		() => finalizePublish({ repo: dir, source, version: VERSION }),
		/src\/nosedive\.ts changed, outside README\.md, package\.json, package-lock\.json/,
	);
	assert.equal(subject(dir), "base");
});

test("package files that do not carry the version are refused, lockfile included", () => {
	const { dir, source } = sourceRepo(tmp, "unstamped");
	assert.throws(
		() => finalizePublish({ repo: dir, source, version: VERSION }),
		/package\.json is 0\.0\.0-dev, not 2026\.8\.25-1787693697086/,
	);

	stampVersion(dir, VERSION);
	write(
		join(dir, "package-lock.json"),
		`${JSON.stringify(
			{
				name: "nosedive",
				version: VERSION,
				packages: { "": { name: "nosedive", version: "0.0.0-dev" } },
			},
			null,
			2,
		)}\n`,
	);
	assert.throws(
		() => finalizePublish({ repo: dir, source, version: VERSION }),
		/package-lock\.json root package is 0\.0\.0-dev/,
	);
});

test("a candidate main has already moved past is refused, not committed onto", () => {
	const { dir, source } = sourceRepo(tmp, "moved-on");
	write(join(dir, "src", "nosedive.ts"), "export const version = 2;\n");
	commitAll(dir, "Land something after the source");
	stampVersion(dir, VERSION);

	assert.throws(
		() => finalizePublish({ repo: dir, source, version: VERSION }),
		/not the release candidate/,
	);
});
