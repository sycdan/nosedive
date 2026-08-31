// Every commit certifies the Developer Certificate of Origin (see DCO).
//   node scripts/check-signoff.mjs                -> commits no remote holds yet
//   node scripts/check-signoff.mjs <base>..<head> -> an explicit range
// Any argument is passed to `git rev-list`, so the caller decides what "new" means:
// a pull request knows its base sha, a push only knows what its remotes hold.
import { spawnSync } from "node:child_process";

const SIGNOFF = /^signed-off-by: .+ <.+@.+>$/im;
// GitHub renders an annotated line against the failing job instead of burying it.
const annotate = process.env.GITHUB_ACTIONS ? "::error::" : "";

// A hook runs this with GIT_DIR set, which would aim git at the hook's repo
// no matter what directory we are standing in.
const env = { ...process.env };
for (const key of [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_PREFIX",
	"GIT_WORK_TREE",
]) {
	delete env[key];
}

function git(args) {
	const result = spawnSync("git", args, { encoding: "utf8", env });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result.stdout;
}

const args = process.argv.slice(2);
const revs = args.length > 0 ? args : ["HEAD", "--not", "--remotes"];
const unsigned = git(["rev-list", "--no-merges", ...revs])
	.split("\n")
	.filter(Boolean)
	.filter((sha) => !SIGNOFF.test(git(["log", "-1", "--format=%B", sha])));

if (unsigned.length > 0) {
	for (const sha of unsigned) {
		console.error(
			`${annotate}no Signed-off-by trailer: ${git(["log", "-1", "--format=%h %s", sha]).trim()}`,
		);
	}
	console.error("Sign off new work with `git commit -s`, or a branch you already have with");
	console.error("`git rebase --signoff <base>`. See CONTRIBUTING.md.");
	process.exit(1);
}
