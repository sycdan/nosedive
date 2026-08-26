// The CalVer versions nosedive publishes under.
//   node scripts/version.mjs                    -> yyyy.m.d-<utc millis>  (dev)
//   node scripts/version.mjs --release          -> yyyy.m.d               (stable)
//   node scripts/version.mjs --release --from V -> promote V instead of package.json
// @see kb/01a03e18-7fe4-7f5c-93f3-64825b38599f.md
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `yyyy.m.d-<utc millis>`, capturing the date a stable release promotes to. */
export const TIMESTAMPED_VERSION = /^(\d{4}\.\d{1,2}\.\d{1,2})-\d+$/;

export function devVersion(now = new Date()) {
	const date = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
	return `${date}-${now.getTime()}`;
}

/**
 * A stable release promotes one already-published dev build, so its date comes
 * from that build's own version and never from the clock the promotion runs on.
 * Sampling the clock would let a build that was made, tested and published as
 * 2026.8.25 ship as 2026.8.26 -- for every promotion that crosses UTC midnight,
 * and for every rerun of one, which would then name a different release than
 * the run it is retrying.
 */
export function releaseVersion(dev) {
	const match = TIMESTAMPED_VERSION.exec(String(dev ?? "").trim());
	if (!match) {
		throw new Error(
			`cannot promote ${dev || "(nothing)"}: expected a timestamped dev version (yyyy.m.d-<utc millis>)`,
		);
	}
	return match[1];
}

/** The version main carries, which is whatever the last finalization stamped. */
export function checkedInVersion(repo = root) {
	return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const fromIndex = args.indexOf("--from");
	const from = fromIndex === -1 ? undefined : args[fromIndex + 1];
	if (fromIndex !== -1 && !from) {
		console.error("--from needs a version");
		process.exit(2);
	}
	if (!args.includes("--release")) {
		console.log(devVersion());
	} else {
		try {
			console.log(releaseVersion(from ?? checkedInVersion()));
		} catch (err) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	}
}
