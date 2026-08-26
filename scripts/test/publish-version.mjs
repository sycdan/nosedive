import assert from "node:assert/strict";
import { test } from "node:test";

import { devVersion, releaseVersion } from "../version.mjs";

test("a dev version is the UTC date and the exact millisecond it was sampled", () => {
	const now = new Date("2026-08-25T23:59:59.500Z");
	assert.equal(devVersion(now), `2026.8.25-${now.getTime()}`);
});

test("dev version date parts are not zero padded, because npm reads them as numbers", () => {
	assert.match(devVersion(new Date("2026-01-06T00:00:00.000Z")), /^2026\.1\.6-\d+$/);
});

test("a stable release takes its date from the build it promotes, not from a clock", () => {
	// The promotion below runs a day after the build it names, which is the case
	// a clock-sampled release would get wrong and this one has to get right.
	assert.equal(releaseVersion("2026.8.25-1787693697086"), "2026.8.25");
});

test("only a timestamped dev version can be promoted", () => {
	assert.throws(() => releaseVersion("0.0.0-dev"), /cannot promote 0\.0\.0-dev/);
	assert.throws(() => releaseVersion(undefined), /cannot promote \(nothing\)/);
});

test("an already stable version is not promotable, so a release cannot promote itself", () => {
	assert.throws(() => releaseVersion("2026.8.25"), /cannot promote 2026\.8\.25/);
});
