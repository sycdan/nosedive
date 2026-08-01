import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parseDocument } from "yaml";

import { isInsideDir } from "./backlogDives.js";
import { CommandIo } from "./bridgeSetupIo.js";
import { formatPath, resolveFrom, splitMarkdownFrontmatter, stringifyYaml } from "./coreParsing.js";
import { gitRelPath } from "./gitState.js";
import { KbDoc, LinkRef, ScopeRef } from "./kbDocs.js";
import { gitOk, gitOutput, writeFileAtomic } from "./renderPlan.js";
import {
	ensureManagedRepoCache,
	ensureSafeTargetPath,
	gitRun,
	resolveRepoDoc,
	runGit,
	uuidLike,
} from "./repoWorkspaceCore.js";
import {
	ensureReusableExistingTarget,
	ProveOptions,
	ensureRepoMarkerExcluded,
	expectedWorktreePath,
	isDirEmpty,
	pruneStaleWorktrees,
	reconcilePushReadOnly,
	resolveRefCommit,
	writeRepoMarker,
} from "./repoWorktrees.js";

export interface ProverHostRequest {
	bridgeDir: string;
	kbDir: string;
	workspaceDir?: string;
	assertionId: string;
	assertionName: string;
	assertionPath: string;
	proverPath: string;
	resultPath: string;
	verbose: boolean;
	record: boolean;
}

export interface ProverHostRepoInput {
	commit: string;
	dirty: boolean;
	path: string;
}

export interface ProverHostResult {
	status: number;
	error?: string;
	inputs: Record<string, ProverHostRepoInput>;
}

export interface RepoContext {
	id: string;
	root: string;
	resolve(path: string): string;
}

export function repoContextForRoot(repoDoc: KbDoc, root: string): RepoContext {
	return {
		id: repoDoc.id,
		root,
		resolve(path: string): string {
			return resolveFrom(root, path);
		},
	};
}

export function parseProveArgs(args: string[]): ProveOptions {
	let assertionRef: string | undefined;
	let record = false;
	let verbose = false;

	for (const arg of args) {
		if (arg === "--record") {
			record = true;
			continue;
		}
		if (arg === "--verbose") {
			verbose = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			throw new Error("Usage: nosedive prove <assertion-ref> [--record] [--verbose]");
		}
		if (arg.startsWith("--")) throw new Error(`unknown prove option: ${arg}`);
		if (assertionRef) throw new Error(`unexpected prove argument: ${arg}`);
		assertionRef = arg;
	}

	if (!assertionRef) throw new Error("prove requires an assertion ref");
	return { assertionRef, record, verbose };
}

export function findAssertionDoc(kbDocs: KbDoc[], assertionId: string): KbDoc {
	const matches = kbDocs.filter((doc) => doc.kind === "assertion" && doc.id === assertionId);
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1) throw new Error(`assertion id is ambiguous: ${assertionId}`);
	throw new Error(`assertion not found: ${assertionId}`);
}

export function findAssertionDocByRef(
	kbDocs: KbDoc[],
	bridgeDir: string,
	assertionRef: string,
): KbDoc {
	if (uuidLike(assertionRef)) return findAssertionDoc(kbDocs, assertionRef);

	const path = resolveFrom(bridgeDir, assertionRef);
	if (!existsSync(path)) throw new Error(`assertion doc not found: ${assertionRef}`);

	const bridgeRoot = realpathSync(bridgeDir);
	const realPath = realpathSync(path);
	if (!isInsideDir(bridgeRoot, realPath)) {
		throw new Error(`assertion path resolves outside the bridge: ${assertionRef}`);
	}

	const doc = kbDocs.find((candidate) => realpathSync(candidate.path) === realPath);
	if (!doc) throw new Error(`assertion doc is not in the bridge KB: ${assertionRef}`);
	if (doc.kind !== "assertion") {
		throw new Error(`prove requires a kind: assertion doc: ${assertionRef}`);
	}
	return doc;
}

export function assertionProverLink(assertion: KbDoc): LinkRef {
	const links = assertion.links.filter((link) => link.rel === "prover");
	if (links.length === 1) return links[0]!;
	if (links.length === 0) throw new Error(`assertion ${assertion.id} is missing a rel=prover link`);
	throw new Error(`assertion ${assertion.id} has more than one rel=prover link`);
}

export function unsafeLinkPath(path: string): boolean {
	return (
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((part) => part === ".." || part === "")
	);
}

export function resolveBridgeFileLink(bridgeDir: string, link: LinkRef, label: string): string {
	const relPath = link.target.slice("file://".length);
	if (!relPath || isAbsolute(relPath)) {
		throw new Error(`${label} must be a bridge-relative file:// link: ${link.target}`);
	}
	if (unsafeLinkPath(relPath)) throw new Error(`${label} has an unsafe path: ${link.target}`);
	const path = resolveFrom(bridgeDir, relPath);
	if (!isInsideDir(bridgeDir, path)) {
		throw new Error(`${label} resolves outside the bridge: ${link.target}`);
	}
	return path;
}

export function resolveKbFileLink(
	bridgeDir: string,
	kbDir: string,
	link: LinkRef,
	label: string,
): string {
	if (link.target.startsWith("file://")) return resolveBridgeFileLink(bridgeDir, link, label);
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link.target)) {
		throw new Error(`${label} must be a repo-root relative file path, not a URI: ${link.target}`);
	}
	if (uuidLike(link.target)) {
		throw new Error(
			`${label} must name an artifact file with a repo-root relative path, not a bare UUID`,
		);
	}
	if (
		!link.target ||
		isAbsolute(link.target) ||
		unsafeLinkPath(link.target) ||
		!link.target.startsWith("kb/")
	) {
		throw new Error(`${label} must be a safe repo-root relative kb/ file path: ${link.target}`);
	}
	const path = resolveFrom(bridgeDir, link.target);
	if (!isInsideDir(kbDir, path)) {
		throw new Error(`${label} resolves outside the KB directory: ${link.target}`);
	}
	return path;
}

export function resolveProverArtifact(bridgeDir: string, kbDir: string, assertion: KbDoc): string {
	const link = assertionProverLink(assertion);
	const path = resolveKbFileLink(bridgeDir, kbDir, link, `assertion ${assertion.id} prover link`);
	if (!existsSync(path)) throw new Error(`prover artifact not found: ${formatPath(path)}`);
	if (!statSync(path).isFile())
		throw new Error(`prover artifact is not a file: ${formatPath(path)}`);
	return path;
}

export function proofRunTempDir(): string {
	return mkdtempSync(join(tmpdir(), "nosedive-proof-"));
}

export function readProverHostResult(path: string): ProverHostResult {
	if (!existsSync(path)) {
		throw new Error(`proof host did not write a result file: ${formatPath(path)}`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as ProverHostResult;
}

export function printProofFailure(
	assertion: KbDoc,
	result: ProverHostResult,
	hostStatus: number | null,
	io: CommandIo,
): void {
	const status = result.status !== 0 ? result.status : (hostStatus ?? result.status);
	io.err(`Proof failed: ${assertion.name} (${assertion.id})`);
	io.err(`Reason: ${result.error ?? `proof failed with exit status ${status}`}`);
}

export function statusEntries(bridgeRoot: string, paths: string[]): string[] {
	const result = runGit(bridgeRoot, ["status", "--porcelain", "-z", "--", ...paths]);
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || "unknown git error";
		throw new Error(`refusing to record proof because git status failed: ${detail}`);
	}
	return result.stdout.split("\0").filter(Boolean);
}

export function assertProverRecordable(bridgeDir: string, proverPath: string): void {
	const bridgeRoot = gitOutput(bridgeDir, ["rev-parse", "--show-toplevel"]);
	if (!bridgeRoot) throw new Error("refusing to record proof because bridge is not a git repo");
	const proverRelPath = gitRelPath(bridgeRoot, proverPath);
	if (!gitOk(bridgeRoot, ["ls-files", "--error-unmatch", "--", proverRelPath])) {
		throw new Error(
			`refusing to record proof because prover is not checked in: ${formatPath(proverPath)}`,
		);
	}
	const proverStatus = statusEntries(bridgeRoot, [proverRelPath]);
	if (proverStatus.length > 0) {
		throw new Error(
			`refusing to record proof because prover has uncommitted changes: ${proverStatus.join(", ")}`,
		);
	}
}

export function recordProofResult(assertionPath: string, result: ProverHostResult): void {
	const text = readFileSync(assertionPath, "utf8");
	const block = splitMarkdownFrontmatter(text, assertionPath);
	const doc = parseDocument(block.yaml);
	if (doc.errors.length > 0) {
		throw new Error(
			`invalid YAML in frontmatter in ${assertionPath}: ${doc.errors[0]?.message ?? "unknown error"}`,
		);
	}

	const commits: Record<string, string> = {};
	for (const [repoId, input] of Object.entries(result.inputs)) {
		commits[repoId] = input.commit;
	}

	doc.setIn(["meta", "last-run"], {
		pass: result.status === 0,
		commits,
	});
	doc.deleteIn(["meta", "last-proven-commit"]);
	doc.deleteIn(["meta", "last-proven"]);

	writeFileAtomic(assertionPath, `---\n${stringifyYaml(doc).trimEnd()}\n---\n${block.body}`);
}

export function scopeForRepo(assertion: KbDoc, repoId: string): ScopeRef | undefined {
	const scopes = assertion.scopes.filter((scope) => scope.repoId === repoId);
	if (scopes.length === 0) return undefined;
	const refs = [...new Set(scopes.map((scope) => scope.ref).filter(Boolean))];
	if (refs.length > 1) {
		throw new Error(`assertion ${assertion.id} has conflicting refs for scoped repo ${repoId}`);
	}
	return scopes[0];
}

export function requiredScopeForRepo(assertion: KbDoc, repoDoc: KbDoc): ScopeRef {
	const scope = scopeForRepo(assertion, repoDoc.id);
	if (!scope) {
		throw new Error(
			`prover requested repo ${repoDoc.name || repoDoc.id} (${repoDoc.id}), but assertion ${assertion.id} does not scope it`,
		);
	}
	return scope;
}

export function validateExistingProverRepo(
	repoId: string,
	scope: ScopeRef,
	targetPath: string,
	commit: string,
): string[] {
	const warnings: string[] = [];
	if (scope.ref) {
		const mergeBase = runGit(targetPath, ["merge-base", "--is-ancestor", commit, "HEAD"]);
		if (mergeBase.status === 1) {
			throw new Error(
				`scoped repo ${repoId} at ${formatPath(targetPath)} cannot prove assertion pinned at ${commit}: pinned commit is not reachable from HEAD`,
			);
		}
		if (mergeBase.status !== 0) {
			const detail = mergeBase.stderr.trim() || mergeBase.stdout.trim() || "unknown git error";
			throw new Error(
				`failed to check pinned commit reachability for scoped repo ${repoId} at ${formatPath(targetPath)}: ${detail}`,
			);
		}

		const head = gitRun(
			targetPath,
			["rev-parse", "HEAD"],
			`failed to inspect HEAD for scoped repo ${repoId}`,
		);
		if (head !== commit) {
			warnings.push(
				`scoped repo ${repoId} at ${formatPath(targetPath)} is ahead of pinned commit ${commit} (${scope.ref}); continuing`,
			);
		}
	}

	const status = gitOutput(targetPath, ["status", "--porcelain"]);
	if (status === undefined) {
		warnings.push(
			`could not read dirty status for scoped repo ${repoId} at ${formatPath(targetPath)}; continuing`,
		);
	} else if (status.trim() !== "") {
		warnings.push(`scoped repo ${repoId} at ${formatPath(targetPath)} is dirty; continuing`);
	}

	return warnings;
}

export function ensureProverRepoHydrated(
	repoDoc: KbDoc,
	assertion: KbDoc,
	request: ProverHostRequest,
	warnings: string[] = [],
): string {
	if (!request.workspaceDir) throw new Error(".nosediverc is missing workspace");
	const repoId = repoDoc.id;
	const scope = requiredScopeForRepo(assertion, repoDoc);
	const targetPath = expectedWorktreePath(repoDoc, request.bridgeDir);
	ensureSafeTargetPath(repoId, targetPath, request.workspaceDir);
	const sourcePath = ensureManagedRepoCache(repoDoc, request.bridgeDir);
	const ref = scope.ref ?? repoDoc.repoBaseBranch ?? "main";
	const commit = resolveRefCommit(sourcePath, repoId, ref);

	if (existsSync(targetPath)) {
		if (!statSync(targetPath).isDirectory()) {
			throw new Error(
				`unsafe target path for repo ${repoId}: target exists but is not a directory: ${formatPath(targetPath)}`,
			);
		}
		if (gitOutput(targetPath, ["rev-parse", "--is-inside-work-tree"])) {
			ensureReusableExistingTarget(repoId, targetPath, sourcePath);
			warnings.push(...validateExistingProverRepo(repoId, scope, targetPath, commit));
			reconcilePushReadOnly(sourcePath, targetPath, scope.readOnly, repoId);
			return targetPath;
		}
		if (!isDirEmpty(targetPath)) {
			throw new Error(
				`unsafe target path for repo ${repoId}: non-empty target is not a git worktree: ${formatPath(targetPath)}`,
			);
		}
	}

	mkdirSync(dirname(targetPath), { recursive: true });
	pruneStaleWorktrees(sourcePath, repoId);
	gitRun(
		sourcePath,
		["worktree", "add", "--detach", targetPath, commit],
		`failed to create worktree for repo ${repoId} at ${formatPath(targetPath)}`,
	);
	writeRepoMarker(targetPath, repoId);
	ensureRepoMarkerExcluded(targetPath, repoId);
	reconcilePushReadOnly(sourcePath, targetPath, scope.readOnly, repoId);
	return targetPath;
}

export function materializeProverRepoContext(
	repoDoc: KbDoc,
	assertion: KbDoc,
	request: ProverHostRequest,
	accessedRepos: Map<string, string>,
	warnings: string[] = [],
): RepoContext {
	const root = ensureProverRepoHydrated(repoDoc, assertion, request, warnings);
	accessedRepos.set(repoDoc.id, root);
	return repoContextForRoot(repoDoc, root);
}

export function prehydrateAssertionScopedRepos(
	kbDocs: KbDoc[],
	assertion: KbDoc,
	request: ProverHostRequest,
	accessedRepos: Map<string, string>,
	warnings: string[],
): void {
	const seen = new Set<string>();
	for (const scope of assertion.scopes) {
		if (scope.repoId === "." || seen.has(scope.repoId)) continue;
		seen.add(scope.repoId);
		const repoDoc = resolveRepoDoc(kbDocs, scope.repoId);
		materializeProverRepoContext(repoDoc, assertion, request, accessedRepos, warnings);
	}
}

export function proofRepoInputs(
	accessedRepos: Map<string, string>,
): Record<string, ProverHostRepoInput> {
	const inputs: Record<string, ProverHostRepoInput> = {};
	for (const [repoId, root] of accessedRepos) {
		const commit = gitRun(root, ["rev-parse", "HEAD"], `failed to read proof input ${repoId}`);
		const status = gitOutput(root, ["status", "--porcelain"]);
		inputs[repoId] = {
			commit,
			dirty: status === undefined ? true : status.trim() !== "",
			path: root,
		};
	}
	return inputs;
}

export function shellishArg(arg: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}

export function formatExecCommand(command: string, args: string[], cwd: string): string {
	const rendered = [command, ...args].map(shellishArg).join(" ");
	return `exec cwd=${formatPath(cwd)} ${rendered}`;
}
