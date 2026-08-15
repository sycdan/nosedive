import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CommandIo } from "./bridgeSetupIo.js";
import { formatPath, resolveFrom, toPosixPath } from "./coreParsing.js";
import { commandForSpawn, spawnOutputText } from "./gitState.js";
import { BridgeConfig, KbDoc, TargetDoc, loadKbDocs } from "./kbDocs.js";
import {
	ProverHostRepoInput,
	ProverHostRequest,
	ProverHostResult,
	RepoContext,
	findAssertionDoc,
	formatExecCommand,
	materializeProverRepoContext,
	prehydrateAssertionScopedRepos,
	proofRepoInputs,
	repoContextForRoot,
} from "./proveCore.js";
import { DriftedScope } from "./provePins.js";
import { cleanGitEnv } from "./gitProcess.js";
import { writeFileAtomic } from "./renderPlan.js";
import { maybeResolveRepoDoc, resolveRepoDoc } from "./repoWorkspaceCore.js";

export function createProverContext(request: ProverHostRequest, io: CommandIo) {
	const kbDocs = loadKbDocs(request.kbDir, request.bridgeDir);
	const assertion = findAssertionDoc(kbDocs, request.assertionId);
	const accessedRepos = new Map<string, string>();
	const warnings: string[] = [];
	const drifted: DriftedScope[] = [];
	const sandboxes: string[] = [];

	function contextForRepo(repoDoc: KbDoc): RepoContext {
		const existingRoot = accessedRepos.get(repoDoc.id);
		if (existingRoot) return repoContextForRoot(repoDoc, existingRoot);
		return materializeProverRepoContext(
			repoDoc,
			assertion,
			request,
			accessedRepos,
			warnings,
			drifted,
		);
	}

	const ctx = {
		assertion: {
			id: assertion.id,
			name: assertion.name,
			path: assertion.path,
			meta: assertion.metaRaw,
			scopes: assertion.scopes,
		},
		bridge: {
			root: request.bridgeDir,
			resolve(path: string): string {
				return resolveFrom(request.bridgeDir, path);
			},
		},
		repos: {
			async get(repoRef: string): Promise<RepoContext | undefined> {
				const repoDoc = maybeResolveRepoDoc(kbDocs, repoRef);
				if (!repoDoc) return undefined;
				return contextForRepo(repoDoc);
			},
			async mustGet(repoRef: string): Promise<RepoContext> {
				const repoDoc = resolveRepoDoc(kbDocs, repoRef);
				return contextForRepo(repoDoc);
			},
			async require(repoRef: string): Promise<RepoContext> {
				return ctx.repos.mustGet(repoRef);
			},
		},
		sandbox: {
			async create(name = "run"): Promise<{ root: string; resolve(path: string): string }> {
				const safeName = name.replace(/[^A-Za-z0-9_.-]/g, "-") || "run";
				const root = mkdtempSync(join(tmpdir(), `nosedive-proof-${safeName}-`));
				sandboxes.push(root);
				return {
					root,
					resolve(path: string): string {
						return resolveFrom(root, path);
					},
				};
			},
		},
		async exec(
			command: string,
			args: string[] = [],
			options?: { cwd?: string; env?: Record<string, string>; expectExitCode?: number },
		): Promise<{ status: number; stdout: string; stderr: string }> {
			if (!options?.cwd) throw new Error("ctx.exec requires options.cwd");
			if (request.verbose) io.log(formatExecCommand(command, args, options.cwd));
			const env = { ...cleanGitEnv(), ...(options.env ?? {}) };
			const spawnCommand = commandForSpawn(command, args);
			const result = spawnSync(spawnCommand.command, spawnCommand.args, {
				cwd: resolve(options.cwd),
				encoding: "utf8",
				env,
			});
			const status = result.status ?? 1;
			const expected = options.expectExitCode ?? 0;
			const stdout = spawnOutputText(result.stdout);
			const stderr = spawnOutputText(result.stderr);
			const execResult = {
				status,
				stdout,
				stderr,
			};
			if (status !== expected) {
				const detail =
					stderr.trim() ||
					stdout.trim() ||
					(result.error instanceof Error ? result.error.message : undefined) ||
					`exit status ${status}`;
				throw new Error(
					`command failed in ${formatPath(options.cwd)}: ${command} ${args.join(" ")}: ${detail}`,
				);
			}
			return execResult;
		},
		fs: {
			async readText(path: string): Promise<string> {
				return readFileSync(path, "utf8");
			},
			async writeText(path: string, contents: string): Promise<void> {
				mkdirSync(dirname(path), { recursive: true });
				writeFileAtomic(path, contents);
			},
			async exists(path: string): Promise<boolean> {
				return existsSync(path);
			},
		},
		git: {
			async init(path: string): Promise<void> {
				await ctx.exec("git", ["init", "-b", "main"], { cwd: path });
			},
		},
		path: nodePath,
		assert: {
			equal(actual: unknown, expected: unknown, message?: string): void {
				if (actual !== expected) throw new Error(message ?? `expected ${expected}, got ${actual}`);
			},
			ok(value: unknown, message?: string): void {
				if (!value) throw new Error(message ?? "expected value to be truthy");
			},
			match(value: string, pattern: RegExp, message?: string): void {
				if (!pattern.test(value))
					throw new Error(message ?? `expected ${value} to match ${pattern}`);
			},
		},
		log(message: string): void {
			io.log(message);
		},
	};

	return {
		ctx,
		prehydrate(): void {
			prehydrateAssertionScopedRepos(kbDocs, assertion, request, accessedRepos, warnings, drifted);
		},
		warnings(): string[] {
			return warnings;
		},
		drifted(): DriftedScope[] {
			return drifted;
		},
		inputs(): Record<string, ProverHostRepoInput> {
			return proofRepoInputs(accessedRepos);
		},
		cleanup(success: boolean): void {
			if (!success) return;
			for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
		},
	};
}

function dirtyProofInputIds(inputs: Record<string, ProverHostRepoInput>): string[] {
	return Object.entries(inputs)
		.filter(([, input]) => input.dirty)
		.map(([repoId]) => repoId);
}

function driftRefusalMessage(drifted: DriftedScope[]): string {
	const lines = drifted.map(
		(scope) =>
			`  ${scope.repoId} at ${formatPath(scope.path)} is at ${scope.head}, pinned at ${scope.pin} (${scope.ref})`,
	);
	const manual = drifted.map(
		(scope) => `  nosedive hydrate-repo.workspace ${scope.repoId} --at ${scope.pin}`,
	);
	return [
		"refusing to record proof because scoped repo(s) have drifted off their pins:",
		...lines,
		"rerun with --rehydrate to move them to their pins, or hydrate them yourself:",
		...manual,
	].join("\n");
}

export async function proveHost(args: string[], io: CommandIo): Promise<void> {
	const [requestPath, ...extra] = args;
	if (!requestPath || extra.length > 0) throw new Error("_prove-host requires one request path");

	const request = JSON.parse(readFileSync(requestPath, "utf8")) as ProverHostRequest;
	const session = createProverContext(request, io);
	let status = 0;
	let error: string | undefined;

	try {
		session.prehydrate();
		for (const warning of session.warnings()) io.err(`WARNING: ${warning}`);
		if (request.record) {
			const dirty = dirtyProofInputIds(session.inputs());
			if (dirty.length > 0) {
				throw new Error(
					`refusing to record proof because accessed repo(s) are dirty: ${dirty.join(", ")}`,
				);
			}
			const drifted = session.drifted();
			if (drifted.length > 0) throw new Error(driftRefusalMessage(drifted));
		}
		io.log(
			request.verbose
				? `Proving: ${request.assertionName} (${request.assertionId})`
				: `Proving: ${request.assertionName}`,
		);
		const mod = (await import(pathToFileURL(request.proverPath).href)) as {
			prove?: (ctx: unknown) => unknown | Promise<unknown>;
		};
		if (typeof mod.prove !== "function") {
			throw new Error(`prover ${formatPath(request.proverPath)} must export prove(ctx)`);
		}
		await mod.prove(session.ctx);
	} catch (err) {
		status = 1;
		error = err instanceof Error ? err.message : String(err);
	} finally {
		session.cleanup(status === 0);
		const result: ProverHostResult = {
			status,
			error,
			inputs: session.inputs(),
		};
		writeFileAtomic(request.resultPath, `${JSON.stringify(result, null, 2)}\n`);
	}

	if (status !== 0) io.setExitCode(status);
}

export function defaultRender(kind: string): "body" | "gist" | undefined {
	if (kind === "foundation") return "body";
	if (
		kind === "convention" ||
		kind === "skill" ||
		kind === "runbook" ||
		kind === "assertion" ||
		kind === "decision"
	)
		return "gist";
	return undefined;
}

export function assertDir(path: string, label: string): void {
	if (!existsSync(path)) throw new Error(`${label} does not exist: ${formatPath(path)}`);
	if (!statSync(path).isDirectory())
		throw new Error(`${label} is not a directory: ${formatPath(path)}`);
}

export function addScopedRepoTargets(options: {
	kbDocs: KbDoc[];
	repoId: string;
	repoRoot: string;
	readOnly: boolean;
	repoLabel: string;
	targets: Map<string, TargetDoc[]>;
	warnings: string[];
}): void {
	const { kbDocs, repoId, repoRoot, readOnly, repoLabel, targets, warnings } = options;

	for (const doc of kbDocs) {
		if (doc.kind === "repo") continue;
		const renderDefault = defaultRender(doc.kind);
		if (!renderDefault) continue;

		for (const scope of doc.scopes) {
			if (scope.repoId !== repoId) continue;

			const targetDir = scope.path ? resolve(repoRoot, scope.path) : repoRoot;
			if (!existsSync(targetDir)) {
				warnings.push(
					`scope path does not exist; skipping ${doc.relPath} -> ${repoLabel}/${toPosixPath(scope.path)}`,
				);
				continue;
			}

			const render = scope.render ?? renderDefault;
			const list = targets.get(targetDir) ?? [];
			if (
				!list.some(
					(item) =>
						item.doc.path === doc.path && item.render === render && item.scopePath === scope.path,
				)
			) {
				list.push({ doc, repoId, render, scopePath: scope.path, readOnly });
			}
			targets.set(targetDir, list);
		}
	}
}

export function shouldGenerateWorkspaceDocs(bridge: BridgeConfig): boolean {
	return Boolean(bridge.workspaceDir && bridge.backlogDir && bridge.effortPath && bridge.effortRef);
}

export function bridgeRunbookTargets(kbDocs: KbDoc[]): TargetDoc[] {
	const targets: TargetDoc[] = [];
	for (const doc of kbDocs) {
		if (doc.kind !== "runbook") continue;
		for (const scope of doc.scopes) {
			if (scope.repoId !== ".") continue;
			const render = scope.render ?? "gist";
			targets.push({ doc, repoId: "", render, scopePath: ".", readOnly: false });
			break;
		}
	}
	return targets;
}
