// Prints CURRENT_COMPATIBILITY_LEVEL.
//
// Read out of src/lib rather than dist/, because dist/ is a bundle -- there is
// no dist/lib/constants.js to import, and the lib entry does not re-export the
// value. This is the same read check-release-surface.mjs already does, kept
// deliberately identical to it rather than inventing a second mechanism.
//
// Used by the publish workflow to derive the `level-<n>` dist-tag, so
// `npx -y nosedive@level-2` resolves the last release that claimed level 2 and
// stops moving on its own once this constant changes.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const libDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib");
const match = readdirSync(libDir)
	.filter((filename) => filename.endsWith(".ts"))
	.map((filename) => readFileSync(join(libDir, filename), "utf8"))
	.map((sourceText) => /\bexport const CURRENT_COMPATIBILITY_LEVEL = ([0-9]+);/.exec(sourceText))
	.find(Boolean);

if (!match) throw new Error("could not read CURRENT_COMPATIBILITY_LEVEL from src/lib");

console.log(match[1]);
