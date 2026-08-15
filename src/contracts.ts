import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createImplRegistry, type CommandImplRegistry } from "./impl/index.js";
import { setCommandIoFactory } from "./impl/commandAdapter.js";
import {
	aheadOfBridgeWarning,
	createStreamingIo,
	CURRENT_COMPATIBILITY_LEVEL,
	formatPath,
	isInsideDir,
	levelGateError,
	maybeBridgeCompatibilityLevel,
	packageDocsOfKind,
	packageRoot,
	parseLinkRefs,
	parseMarkdownDoc,
	parseScopeRefs,
	resolveFrom,
	setCommandHelpPrinter,
	setTopLevelHelpRenderer,
	toPosixPath,
	unsafeLinkPath,
	type CommandIo,
	type KbDoc,
} from "./lib/commands.js";
import { lib, namespacedUuid, type CommandLibRegistry } from "./lib/index.js";
import { executePrompt } from "./lib/promptExecution.js";
const USAGE_HEADER = "Usage: nosedive <command>";

interface ContractDoc extends KbDoc {
	body: string;
	command: string;
	compatibilityLevel: number;
	adapter: string;
	entrypoint: string;
	usage: string;
	agentsUseWhen: string;
	useInstead: string;
}

interface ParsedCommand {
	name: string;
	explicitCompatibilityLevel?: number;
}

interface ContractRunContext {
	command: string;
	cwd: string;
	requestedCompatibilityLevel: number;
	commandCompatibilityLevel: number;
	commandDoc: {
		id?: string;
		name: string;
		path: string;
	};
	/** @deprecated Use commandCompatibilityLevel. */
	contractCompatibilityLevel: number;
	/** @deprecated Use commandDoc. */
	contract: {
		id?: string;
		name: string;
		path: string;
	};
	impl: CommandImplRegistry;
	lib: CommandLibRegistry;
}

interface ContractRunOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function packageProjectId(): string {
	const refPath = join(packageRoot(), ".nosedive-ref");
	const match = /^id:\s*(\S+)\s*$/m.exec(readFileSync(refPath, "utf8"));
	const id = match?.[1];
	if (!id) throw new Error(`${formatPath(refPath)} is missing id`);
	return id;
}

function commandDocId(command: string, compatibilityLevel: number): string {
	return namespacedUuid(packageProjectId(), `command:${command}@${compatibilityLevel}`);
}

export function parseCommandToken(command: string | undefined): ParsedCommand | undefined {
	if (command === undefined) return undefined;
	const match = /^(.+)@([0-9]+)$/.exec(command);
	if (!match) return { name: command };
	return {
		name: match[1]!,
		explicitCompatibilityLevel: Number.parseInt(match[2]!, 10),
	};
}

function parseContractName(
	name: string | undefined,
	label: string,
): { command: string; compatibilityLevel: number } | undefined {
	const match = /^(.+)@([0-9]+)$/.exec(name ?? "");
	if (!match) return undefined;
	const compatibilityLevel = Number.parseInt(match[2]!, 10);
	if (!Number.isInteger(compatibilityLevel) || compatibilityLevel < 0) {
		throw new Error(`invalid command name in ${label}: ${name}`);
	}
	return { command: match[1]!, compatibilityLevel };
}

function parsePackageContractDoc(path: string, content: string): ContractDoc {
	const label = formatPath(path);
	const parsed = parseMarkdownDoc(content, label);
	const contractName = parseContractName(parsed.fm.scalars.name, label);
	if (!contractName) {
		throw new Error(`command ${formatPath(path)} name must look like <command>@<level>`);
	}
	return {
		path,
		relPath: toPosixPath(relative(packageRoot(), path)),
		id: parsed.fm.scalars.id,
		name: parsed.fm.scalars.name,
		kind: parsed.fm.scalars.kind,
		gist: parsed.fm.scalars.gist,
		repoPath: undefined,
		repoBaseBranch: undefined,
		effortRef: undefined,
		// Body facts about dives; a command doc has neither.
		hasBrief: false,
		hasLog: false,
		metaScalars: parsed.fm.nested.meta ?? {},
		metaLists: parsed.fm.nestedLists.meta ?? {},
		metaRaw:
			parsed.fm.raw.meta &&
			typeof parsed.fm.raw.meta === "object" &&
			!Array.isArray(parsed.fm.raw.meta)
				? (parsed.fm.raw.meta as Record<string, unknown>)
				: {},
		hasScopes: Object.hasOwn(parsed.fm.raw, "scopes"),
		scopes: parseScopeRefs(parsed.fm.raw.scopes, path),
		links: parseLinkRefs(parsed.fm.raw.links, path),
		body: parsed.body,
		command: contractName.command,
		compatibilityLevel: contractName.compatibilityLevel,
		adapter: parsed.fm.nested.meta?.adapter ?? "",
		entrypoint: parsed.fm.nested.meta?.entrypoint ?? "",
		usage: parsed.fm.nested.meta?.usage ?? "",
		agentsUseWhen: parsed.fm.nested.meta?.["agents-use-when"] ?? "",
		useInstead: parsed.fm.nested.meta?.["use-instead"] ?? "",
	};
}

function packageContractDoc(command: string, compatibilityLevel: number): ContractDoc | undefined {
	const id = commandDocId(command, compatibilityLevel);
	const path = join(packageRoot(), "kb", `${id}.md`);
	if (!existsSync(path)) return undefined;
	const contract = parsePackageContractDoc(path, readFileSync(path, "utf8"));
	if (contract.id !== id) {
		throw new Error(`command ${formatPath(path)} id must match deterministic command id ${id}`);
	}
	if (contract.command !== command || contract.compatibilityLevel !== compatibilityLevel) {
		throw new Error(
			`command ${formatPath(path)} name must be ${command}@${compatibilityLevel}, got ${contract.name}`,
		);
	}
	return contract;
}

function packageContractDocs(): ContractDoc[] {
	const packageKbDir = join(packageRoot(), "kb");
	return packageDocsOfKind("command").map((doc) =>
		parsePackageContractDoc(join(packageKbDir, doc.filename), doc.content),
	);
}

function resolveContract(
	command: string,
	targetLevel: number,
	exact: boolean,
): ContractDoc | undefined {
	for (let level = targetLevel; level >= 0; level -= 1) {
		const contract = packageContractDoc(command, level);
		if (contract) return contract;
		if (exact) return undefined;
	}
	return undefined;
}

function renderContractHelpText(contract: ContractDoc): string {
	const body = contract.body.trim();
	const usage = contract.usage.trim();
	const gist = contract.gist.trim();
	const usageLine = usage ? `Usage: ${usage}` : "";
	const usageBlock = [usageLine, gist].filter(Boolean).join("\n\n");
	const longestBacktickRun = Math.max(
		2,
		...[...body.matchAll(/`+/g)].map((match) => match[0].length),
	);
	const fence = "`".repeat(longestBacktickRun + 1);
	const bodyBlock = body ? [`${fence}md`, body, fence].join("\n") : "";
	return [bodyBlock, usageBlock].filter(Boolean).join("\n\n");
}

function latestContractDocs(): ContractDoc[] {
	const latestByCommand = new Map<string, ContractDoc>();
	for (const contract of packageContractDocs()) {
		if (contract.command.startsWith("_")) continue;
		if (isDeprecatedContract(contract)) continue;
		const existing = latestByCommand.get(contract.command);
		if (!existing || contract.compatibilityLevel > existing.compatibilityLevel) {
			latestByCommand.set(contract.command, contract);
		}
	}
	return [...latestByCommand.values()].sort((a, b) => a.command.localeCompare(b.command));
}

function isDeprecatedContract(contract: ContractDoc): boolean {
	return contract.useInstead.trim() !== "";
}

/**
 * The pilot surface is a scanned table; the agent surface trades that density
 * for a block per command, so a command's `Use when:` trigger cannot be read
 * against the wrong command. A command with no `meta.agents-use-when` has no
 * agent-facing trigger to state, so it is left off the agent surface.
 */
export function renderTopLevelHelpText(options?: { agents?: boolean }): string {
	const contracts = latestContractDocs().filter(
		(contract) => !options?.agents || contract.agentsUseWhen.trim() !== "",
	);
	const lines = [USAGE_HEADER, "", "Commands:"];
	if (options?.agents) {
		for (const contract of contracts) {
			lines.push("", `  ${contract.command}`, `    ${contract.gist}`);
			lines.push(`    Use when: ${contract.agentsUseWhen.trim()}`);
		}
	} else {
		const commandWidth = Math.max(0, ...contracts.map((contract) => contract.command.length));
		for (const contract of contracts) {
			const command = contract.command.padEnd(commandWidth);
			lines.push(`  ${command}  ${contract.gist}`);
		}
	}
	lines.push("", "Run `nosedive <command> --help` for details on a command.");
	return `${lines.join("\n")}\n`;
}

function renderContractHelp(contract: ContractDoc): void {
	const help = renderContractHelpText(contract);
	if (help) console.log(help);
}

export function printCommandHelp(command: string, io: CommandIo): void {
	const contract = packageContractDocs()
		.filter((doc) => doc.command === command)
		.sort((a, b) => b.compatibilityLevel - a.compatibilityLevel)[0];
	if (!contract) throw new Error(`no packaged command document for command: ${command}`);
	io.log(renderContractHelpText(contract));
}

setCommandHelpPrinter(printCommandHelp);
setTopLevelHelpRenderer(renderTopLevelHelpText);

export function isContractedCommand(command: string): boolean {
	return latestContractDocs().some((doc) => doc.command === command);
}

function contractStreamField(
	fields: Record<string, unknown>,
	key: "stdout" | "stderr" | "output",
	contract: ContractDoc,
): string {
	const value = fields[key];
	if (value === undefined) return "";
	if (typeof value !== "string") {
		throw new Error(`command ${contract.name} must return ${key} as a string`);
	}
	return value;
}

function assertContractRunOutput(value: unknown, contract: ContractDoc): ContractRunOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`command ${contract.name} must return { stdout, stderr, exitCode }`);
	}
	const fields = value as Record<string, unknown>;
	if (fields.stdout !== undefined && fields.output !== undefined) {
		throw new Error(`command ${contract.name} must not return both stdout and output`);
	}
	const exitCode = fields.exitCode;
	if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
		throw new Error(`command ${contract.name} must return exitCode as an integer`);
	}
	const stdout =
		fields.stdout !== undefined
			? contractStreamField(fields, "stdout", contract)
			: contractStreamField(fields, "output", contract);
	return { stdout, stderr: contractStreamField(fields, "stderr", contract), exitCode };
}

function resolvePackageRootFile(path: string, label: string): string {
	if (!path || isAbsolute(path) || unsafeLinkPath(path)) {
		throw new Error(`${label} must be a safe package-root-relative file path: ${path}`);
	}
	const resolved = resolveFrom(packageRoot(), path);
	if (!isInsideDir(packageRoot(), resolved)) {
		throw new Error(`${label} resolves outside the package: ${path}`);
	}
	return resolved;
}

async function runContractAdapter(
	contract: ContractDoc,
	args: string[],
	requestedCompatibilityLevel: number,
): Promise<ContractRunOutput> {
	if (!contract.adapter) {
		throw new Error(`command ${contract.name} has no meta.adapter`);
	}
	if (!contract.entrypoint) {
		throw new Error(`command ${contract.name} has no meta.entrypoint`);
	}

	const value: unknown = { args, cwd: process.cwd() };
	const ctx: ContractRunContext = {
		command: contract.command,
		cwd: process.cwd(),
		requestedCompatibilityLevel,
		commandCompatibilityLevel: contract.compatibilityLevel,
		commandDoc: {
			id: contract.id,
			name: contract.name,
			path: contract.path,
		},
		contractCompatibilityLevel: contract.compatibilityLevel,
		contract: {
			id: contract.id,
			name: contract.name,
			path: contract.path,
		},
		impl: createImplRegistry({
			cwd: process.cwd(),
			commandDoc: { id: contract.id, name: contract.name, path: contract.path },
		}),
		lib,
	};

	const artifactPath = resolvePackageRootFile(contract.adapter, `command ${contract.name} adapter`);
	if (!existsSync(artifactPath)) {
		throw new Error(`command adapter not found: ${formatPath(artifactPath)}`);
	}
	if (!statSync(artifactPath).isFile()) {
		throw new Error(`command adapter is not a file: ${formatPath(artifactPath)}`);
	}
	const mod = (await import(pathToFileURL(artifactPath).href)) as Record<string, unknown>;
	const entrypoint = mod[contract.entrypoint];
	if (typeof entrypoint !== "function") {
		throw new Error(
			`command adapter ${formatPath(artifactPath)} must export ${contract.entrypoint}(value, ctx)`,
		);
	}

	const result = assertContractRunOutput(await entrypoint(value, ctx), contract);
	return result;
}

function writeCommandOutput(result: ContractRunOutput): void {
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

async function runPromptCommand(
	contract: ContractDoc,
	args: string[],
	targetLevel: number,
): Promise<void> {
	const exec = args.includes("--exec");
	setCommandIoFactory(() => createStreamingIo(exec ? { stdout: false } : undefined));
	let result: ContractRunOutput;
	try {
		result = await runContractAdapter(
			contract,
			exec ? args.filter((arg) => arg !== "--exec") : args,
			targetLevel,
		);
	} finally {
		setCommandIoFactory(undefined);
	}
	if (!exec) {
		writeCommandOutput(result);
		return;
	}
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.exitCode !== 0) {
		process.exitCode = result.exitCode;
		return;
	}
	executePrompt(contract.command, contract.path, result.stdout);
}

/**
 * Exempt from the generic level gate: `seed` because it migrates, `preflight`
 * because drift is its to report -- it names the levels in the gap and still
 * fails, just better.
 */
const LEVEL_GATE_EXEMPT = new Set(["seed", "preflight"]);

export async function maybeRunContractCommand(
	parsed: ParsedCommand,
	args: string[],
): Promise<boolean> {
	const explicitLevel = parsed.explicitCompatibilityLevel;
	const exact = explicitLevel !== undefined;
	const bridgeLevel = maybeBridgeCompatibilityLevel(process.cwd());
	const isHelp = args.length === 1 && (args[0] === "-h" || args[0] === "--help");

	// Refuse only what the package cannot read: a gap with a migration in it.
	if (
		!exact &&
		bridgeLevel !== undefined &&
		!isHelp &&
		!LEVEL_GATE_EXEMPT.has(parsed.name) &&
		packageContractDoc(parsed.name, CURRENT_COMPATIBILITY_LEVEL) !== undefined
	) {
		const refusal = levelGateError(bridgeLevel);
		if (refusal) throw refusal;
	}

	const targetLevel = exact
		? explicitLevel
		: parsed.name.startsWith("_") || LEVEL_GATE_EXEMPT.has(parsed.name)
			? CURRENT_COMPATIBILITY_LEVEL
			: (bridgeLevel ?? CURRENT_COMPATIBILITY_LEVEL);

	const contract = resolveContract(parsed.name, targetLevel, exact);
	if (!contract) {
		if (exact) throw new Error(`command not found: ${parsed.name}@${targetLevel}`);
		return false;
	}

	if (isHelp) {
		renderContractHelp(contract);
		return true;
	}

	if (exact) {
		const warning = aheadOfBridgeWarning(parsed.name, explicitLevel, bridgeLevel);
		if (warning) process.stderr.write(warning);
	}
	await runPromptCommand(contract, args, targetLevel);
	return true;
}
