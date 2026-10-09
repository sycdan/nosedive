/**
 * Shipped gate for kb/00000000-0000-7d9b-bd90-df6c304acccb.md -- repo create.
 *
 * Runs from the package, so it reads the kb and runs seed through nosedive's own dist.
 * Throwing fails the gate; progress goes to stderr.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readKbDocById, readNosediveRc } from "../../dist/nosedive.js";

const SEED_CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^[^@\s]+@[^:\s]+:.+/;

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout.trim();
}

function tryGit(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : undefined;
}

/** The repo docs the dive made, read from its `__self` checkout first, then the live bridge. */
function madeRepoDocs(rc, dive, self) {
	const kbRel = relative(rc.bridgeDir, rc.kbDir);
	const kbs = [...(self ? [join(rc.bridgeDir, self.root, kbRel)] : []), rc.kbDir];
	return dive.links
		.filter((link) => link.rel === "made" && (!link.repo || link.repo === rc.bridge))
		.map((link) =>
			kbs.map((kb) => readKbDocById(kb, rc.bridgeDir, link.id)).find((doc) => doc !== undefined),
		)
		.filter((doc) => doc?.kind === "repo");
}

/** Where the repo goes: `<local>.git`, relative to the bridge, `~` to home. */
function targetOf(repo, bridgeRoot) {
	const local = repo.metaRaw.remotes?.local;
	if (typeof local !== "string" || !local.trim()) return undefined;
	if (URL_LIKE.test(local.trim()))
		throw new Error(`repo ${repo.name} (${repo.id}): remotes.local must be a path, not ${local}`);
	const expanded = local.trim().replace(/^~(?=$|[\\/])/, homedir());
	const path = isAbsolute(expanded) ? resolve(expanded) : resolve(bridgeRoot, expanded);
	return path.endsWith(".git") ? path : `${path}.git`;
}

/** Seeds a clone of the empty bare repo as a bridge whose own repo doc is this one, and pushes it. */
function seedRepo(target, repo, trunk, bridgeRoot) {
	const parent = mkdtempSync(join(tmpdir(), "nosedive-repo-create-"));
	// Seed names the bridge's own repo doc and backlog after its directory.
	const work = join(parent, repo.name);
	try {
		git(parent, ["clone", "-q", target, work]);
		git(work, ["symbolic-ref", "HEAD", `refs/heads/${trunk}`]);
		// The bridge's identity, when it has one, is the pilot's for this work.
		for (const key of ["name", "email"]) {
			const value = tryGit(bridgeRoot, ["config", `user.${key}`]);
			if (value) git(work, ["config", `user.${key}`, value]);
		}
		const args = ["seed", "--headless", "--no-agents", "--no-push", "--repo-id", repo.id];
		const seeded = spawnSync(process.execPath, [SEED_CLI, ...args], { cwd: work, encoding: "utf8" });
		if (seeded.status !== 0)
			throw new Error(`nosedive ${args.join(" ")} failed: ${(seeded.stderr || seeded.stdout).trim()}`);
		git(work, ["push", "-q", "origin", `HEAD:refs/heads/${trunk}`]);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
}

/**
 * What is at the target: "keep" for a bridge of this repo, "fill" for an empty
 * repository, "create" for nothing or an empty directory. Anything else throws.
 */
function inspect(repo, target, trunk, bridgeRoot) {
	const label = `repo ${repo.name} (${repo.id}) at ${target}`;
	if (!existsSync(target) || readdirSync(target).length === 0) return "create";
	const bare = [`--git-dir=${target}`];
	if (!tryGit(bridgeRoot, [...bare, "rev-parse", "--git-dir"]))
		throw new Error(`${label}: something else is there; move it or change remotes.local`);
	if (!tryGit(bridgeRoot, [...bare, "for-each-ref", "--count=1"])) return "fill";
	const config = tryGit(bridgeRoot, [...bare, "show", `refs/heads/${trunk}:.nosedive/config.yaml`]);
	const id = /^bridge:\s*(\S+)/m.exec(config ?? "")?.[1];
	if (id !== repo.id)
		throw new Error(
			`${label}: a repository is there whose ${trunk} is ${id ? `the bridge of ${id}` : "no bridge"}; move it or change remotes.local`,
		);
	return "keep";
}

function ensureRepo(repo, target, trunk, state, bridgeRoot) {
	const label = `repo ${repo.name} (${repo.id}) at ${target}`;
	if (state === "keep") return console.error(`repo-create: ${label} already exists; kept`);
	if (state === "create") git(bridgeRoot, ["init", "-q", "--bare", target]);
	git(bridgeRoot, [`--git-dir=${target}`, "symbolic-ref", "HEAD", `refs/heads/${trunk}`]);
	seedRepo(target, repo, trunk, bridgeRoot);
	console.error(`repo-create: created ${label} on ${trunk}`);
}

export async function run(ctx) {
	const rc = readNosediveRc(ctx.bridgeRoot);
	const dive = await ctx.resolve(ctx.diveId);
	const self = Object.values(ctx.repos ?? {}).find((repo) => repo.id === rc.bridge);
	const repos = madeRepoDocs(rc, dive, self);
	if (repos.length === 0) return console.error("repo-create: the dive made no repo docs");
	// Every target is inspected before any is made, so one refusal makes none.
	const planned = [];
	for (const repo of repos) {
		const target = targetOf(repo, rc.bridgeDir);
		if (!target) console.error(`repo-create: repo ${repo.name} has no remotes.local; skipped`);
		else {
			const trunk = repo.metaScalars.trunk || "main";
			planned.push({ repo, target, trunk, state: inspect(repo, target, trunk, rc.bridgeDir) });
		}
	}
	for (const { repo, target, trunk, state } of planned)
		ensureRepo(repo, target, trunk, state, rc.bridgeDir);
}
