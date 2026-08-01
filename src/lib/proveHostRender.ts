import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CommandIo } from "./bridgeSetupIo.js";
import { formatPath, resolveFrom, scalarToString } from "./coreParsing.js";
import { commandForSpawn, spawnOutputText } from "./gitState.js";
import { BridgeConfig, KbDoc, LinkRef, ScopeRef, TargetDoc, loadKbDocs } from "./kbDocs.js";
import {
	ProverHostRepoInput,
	ProverHostRequest,
	ProverHostResult,
	RepoContext,
	findAssertionDoc,
	formatExecCommand,
	materializeProverRepoContext,
	proofRepoInputs,
} from "./proveCore.js";
import { cleanGitEnv, writeFileAtomic } from "./renderPlan.js";
import { maybeResolveRepoDoc, resolveRepoDoc, uuidLike } from "./repoWorkspaceCore.js";

export function createProverContext(request: ProverHostRequest) {
	const kbDocs = loadKbDocs(request.kbDir, request.bridgeDir);
	const assertion = findAssertionDoc(kbDocs, request.assertionId);
	const accessedRepos = new Map<string, string>();
	const sandboxes: string[] = [];

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
				return materializeProverRepoContext(repoDoc, assertion, request, accessedRepos);
			},
			async require(repoRef: string): Promise<RepoContext> {
				const repoDoc = resolveRepoDoc(kbDocs, repoRef);
				return materializeProverRepoContext(repoDoc, assertion, request, accessedRepos);
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
			if (request.verbose) console.log(formatExecCommand(command, args, options.cwd));
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
			console.log(message);
		},
	};

	return {
		ctx,
		inputs(): Record<string, ProverHostRepoInput> {
			return proofRepoInputs(accessedRepos);
		},
		cleanup(success: boolean): void {
			if (!success) return;
			for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
		},
	};
}

export async function proveHost(args: string[], io: CommandIo): Promise<void> {
	const [requestPath, ...extra] = args;
	if (!requestPath || extra.length > 0) throw new Error("__prove-host requires one request path");

	const request = JSON.parse(readFileSync(requestPath, "utf8")) as ProverHostRequest;
	const session = createProverContext(request);
	let status = 0;
	let error: string | undefined;

	try {
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

export function optionalScopeString(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!Object.hasOwn(value, key)) return undefined;
	const scalar = scalarToString(value[key]);
	if (scalar === undefined || scalar.trim() === "") {
		throw new Error(`invalid scope entry in ${label}: ${key} must be a non-empty string`);
	}
	return scalar;
}

export function optionalScopeFlags(value: Record<string, unknown>, label: string): string[] {
	if (!Object.hasOwn(value, "flags")) return [];
	const raw = value.flags;
	if (!Array.isArray(raw))
		throw new Error(`invalid scope entry in ${label}: flags must be a YAML list`);
	return raw.map((entry) => {
		const flag = scalarToString(entry);
		if (!flag || flag.trim() === "")
			throw new Error(`invalid scope entry in ${label}: flags must contain non-empty strings`);
		return flag;
	});
}

export function parseScopeRef(scope: unknown, path: string, index: number): ScopeRef {
	const label = `${path} scopes[${index}]`;
	if (typeof scope === "string") {
		const repoId = scope.trim();
		if (uuidLike(repoId)) {
			return { repoId, path: "", readOnly: false, flags: [] };
		}
		throw new Error(
			`legacy scope shorthand is not supported in ${label}; use a bare UUID or '- <repo-id>: { ... }' object form`,
		);
	}
	if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
		throw new Error(`invalid scope entry in ${label}: expected a one-key object`);
	}

	const keys = Object.keys(scope as Record<string, unknown>);
	if (keys.length !== 1) {
		throw new Error(`invalid scope entry in ${label}: expected exactly one repo id key`);
	}

	const repoId = keys[0]!.trim();
	if (!repoId) throw new Error(`invalid scope entry in ${label}: repo id key must be non-empty`);

	const rawValue = (scope as Record<string, unknown>)[repoId];
	if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
		throw new Error(`invalid scope entry in ${label}: value for '${repoId}' must be a YAML object`);
	}

	const value = rawValue as Record<string, unknown>;
	const ref = optionalScopeString(value, "ref", label);
	const pathValue = optionalScopeString(value, "path", label) ?? "";
	const mode = optionalScopeString(value, "mode", label);
	const render = optionalScopeString(value, "render", label) as "body" | "gist" | undefined;
	const flags = optionalScopeFlags(value, label);

	if (render && render !== "body" && render !== "gist") {
		throw new Error(`invalid scope entry in ${label}: render must be 'body' or 'gist'`);
	}
	if (mode && mode !== "ro" && mode !== "rw") {
		throw new Error(`invalid scope entry in ${label}: mode must be 'ro' or 'rw'`);
	}
	if (flags.some((flag) => flag === "body" || flag === "gist")) {
		throw new Error(`invalid scope entry in ${label}: body/gist must use render, not flags`);
	}

	const flagReadOnly = flags.includes("ro");
	if (mode === "rw" && flagReadOnly) {
		throw new Error(`invalid scope entry in ${label}: mode=rw conflicts with flags containing ro`);
	}

	if (repoId === ".") {
		if (ref) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set ref`);
		if (pathValue) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set path`);
		if (mode) throw new Error(`invalid scope entry in ${label}: '.' scope cannot set mode`);
	}

	return {
		repoId,
		path: pathValue,
		ref,
		readOnly: mode ? mode === "ro" : flagReadOnly,
		flags,
		render,
	};
}

export function parseScopeRefs(value: unknown, path: string): ScopeRef[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`invalid scopes in ${path}: expected a YAML list`);
	return value.map((scope, index) => parseScopeRef(scope, path, index));
}

export function optionalLinkString(
	value: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!Object.hasOwn(value, key)) return undefined;
	const scalar = scalarToString(value[key]);
	if (scalar === undefined || scalar.trim() === "") {
		throw new Error(`invalid link entry in ${label}: ${key} must be a non-empty string`);
	}
	return scalar;
}

function linkDocId(target: string): string {
	const kbDocMatch =
		/^kb\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i.exec(target);
	if (kbDocMatch) return kbDocMatch[1]!.toLowerCase();
	return target;
}

export function parseLinkRef(link: unknown, path: string, index: number): LinkRef {
	const label = `${path} links[${index}]`;
	if (typeof link === "string") {
		const target = link.trim();
		if (!target) throw new Error(`invalid link entry in ${label}: target must be non-empty`);
		if (target.includes("#")) {
			const [targetPath, ...anchorParts] = target.split("#");
			const anchor = anchorParts.join("#");
			if (!targetPath || !anchor) {
				throw new Error(`invalid link entry in ${label}: target and anchor must be non-empty`);
			}
			return { id: linkDocId(targetPath), target: targetPath, anchor };
		}
		return { id: linkDocId(target), target };
	}
	if (!link || typeof link !== "object" || Array.isArray(link)) {
		throw new Error(
			`invalid link entry in ${label}: expected a bare target string or a one-key object`,
		);
	}

	const keys = Object.keys(link as Record<string, unknown>);
	if (keys.length !== 1) {
		throw new Error(`invalid link entry in ${label}: expected exactly one target key`);
	}

	const target = keys[0]!.trim();
	if (!target) throw new Error(`invalid link entry in ${label}: target key must be non-empty`);

	const rawValue = (link as Record<string, unknown>)[keys[0]!];
	if (rawValue === null || rawValue === undefined) return { id: linkDocId(target), target };
	if (typeof rawValue !== "object" || Array.isArray(rawValue)) {
		throw new Error(`invalid link entry in ${label}: value for '${target}' must be a YAML object`);
	}

	const value = rawValue as Record<string, unknown>;
	const rel = optionalLinkString(value, "rel", label);
	const anchor = optionalLinkString(value, "anchor", label);
	return { id: linkDocId(target), target, rel, anchor };
}

export function parseLinkRefs(value: unknown, path: string): LinkRef[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new Error(`invalid links in ${path}: expected a YAML list`);
	return value.map((link, index) => parseLinkRef(link, path, index));
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
	if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}`);
	if (!statSync(path).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
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
					`scope path does not exist; skipping ${doc.relPath} -> ${repoLabel}/${scope.path}`,
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
