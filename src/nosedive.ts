import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createImplRegistry, type CommandImplRegistry } from "./impl/index.js";
import {
	CURRENT_COMPATIBILITY_LEVEL,
	type CapturedCommandOutput,
	type CommandIo,
	type KbDoc,
	type LinkRef,
	type ScopeRef,
	bridgeCompatibilityLevel,
	createCapturingIo,
	createConsoleIo,
	formatPath,
	isInsideDir,
	packageDocsOfKind,
	packageRoot,
	parseLinkRefs,
	parseMarkdownDoc,
	parseScopeRefs,
	proveHost,
	readNosediveRc,
	resolveFrom,
	runLegacyCommand,
	setCommandHelpPrinter,
	unsafeLinkPath,
	writeNosediveRcCurrent,
} from "./lib/commands.js";
import { lib, namespacedUuid, type CommandLibRegistry } from "./lib/index.js";

export { createCapturingIo, createConsoleIo, readNosediveRc, writeNosediveRcCurrent };

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const USAGE_HEADER = "Usage: nosedive <command>";

interface ContractDoc extends KbDoc {
	body: string;
	command: string;
	compatibilityLevel: number;
	handler: string;
	usage: string;
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

function parseCommandToken(command: string | undefined): ParsedCommand | undefined {
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
	const parsed = parseMarkdownDoc(content, path);
	const contractName = parseContractName(parsed.fm.scalars.name, path);
	if (!contractName) {
		throw new Error(`command ${formatPath(path)} name must look like <command>@<level>`);
	}
	return {
		path,
		relPath: relative(packageRoot(), path),
		id: parsed.fm.scalars.id,
		name: parsed.fm.scalars.name,
		kind: parsed.fm.scalars.kind,
		gist: parsed.fm.scalars.gist,
		repoPath: undefined,
		repoBaseBranch: undefined,
		effortRef: undefined,
		metaScalars: parsed.fm.nested.meta ?? {},
		metaLists: parsed.fm.nestedLists.meta ?? {},
		metaRaw:
			parsed.fm.raw.meta &&
			typeof parsed.fm.raw.meta === "object" &&
			!Array.isArray(parsed.fm.raw.meta)
				? (parsed.fm.raw.meta as Record<string, unknown>)
				: {},
		scopes: parseScopeRefs(parsed.fm.raw.scopes, path),
		links: parseLinkRefs(parsed.fm.raw.links, path),
		body: parsed.body,
		command: contractName.command,
		compatibilityLevel: contractName.compatibilityLevel,
		handler: parsed.fm.nested.meta?.handler ?? "",
		usage: parsed.fm.nested.meta?.usage ?? "",
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

function maybeBridgeCompatibilityLevel(start: string): number | undefined {
	try {
		return bridgeCompatibilityLevel(start);
	} catch {
		return undefined;
	}
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
		const existing = latestByCommand.get(contract.command);
		if (!existing || contract.compatibilityLevel > existing.compatibilityLevel) {
			latestByCommand.set(contract.command, contract);
		}
	}
	return [...latestByCommand.values()].sort((a, b) => a.command.localeCompare(b.command));
}

function renderTopLevelHelpText(): string {
	const contracts = latestContractDocs();
	const commandWidth = Math.max(0, ...contracts.map((contract) => contract.command.length));
	const lines = [USAGE_HEADER, "", "Commands:"];
	for (const contract of contracts) {
		const command = contract.command.padEnd(commandWidth);
		lines.push(`  ${command}  ${contract.gist}`);
	}
	lines.push("", "Run `nosedive <command> --help` for details on a command.");
	return `${lines.join("\n")}\n`;
}

function renderContractHelp(contract: ContractDoc): void {
	const help = renderContractHelpText(contract);
	if (help) console.log(help);
}

function printCommandHelp(command: string, io: CommandIo): void {
	const contract = packageContractDocs()
		.filter((doc) => doc.command === command)
		.sort((a, b) => b.compatibilityLevel - a.compatibilityLevel)[0];
	if (!contract) throw new Error(`no packaged command document for command: ${command}`);
	io.log(renderContractHelpText(contract));
}

setCommandHelpPrinter(printCommandHelp);

function isContractedCommand(command: string): boolean {
	return packageContractDocs().some((doc) => doc.command === command);
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

async function runContractHandler(
	contract: ContractDoc,
	args: string[],
	requestedCompatibilityLevel: number,
): Promise<void> {
	if (!contract.handler) {
		throw new Error(`command ${contract.name} has no meta.handler`);
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
		impl: createImplRegistry({ cwd: process.cwd() }),
		lib,
	};

	const artifactPath = resolvePackageRootFile(contract.handler, `command ${contract.name} handler`);
	if (!existsSync(artifactPath)) {
		throw new Error(`command handler not found: ${formatPath(artifactPath)}`);
	}
	if (!statSync(artifactPath).isFile()) {
		throw new Error(`command handler is not a file: ${formatPath(artifactPath)}`);
	}
	const mod = (await import(pathToFileURL(artifactPath).href)) as {
		handle?: (value: unknown, ctx: ContractRunContext) => unknown | Promise<unknown>;
	};
	if (typeof mod.handle !== "function") {
		throw new Error(`command handler ${formatPath(artifactPath)} must export handle(value, ctx)`);
	}

	const result = assertContractRunOutput(await mod.handle(value, ctx), contract);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

async function maybeRunContractCommand(parsed: ParsedCommand, args: string[]): Promise<boolean> {
	const explicitLevel = parsed.explicitCompatibilityLevel;
	const exact = explicitLevel !== undefined;
	const targetLevel = exact
		? explicitLevel
		: (maybeBridgeCompatibilityLevel(process.cwd()) ?? CURRENT_COMPATIBILITY_LEVEL);

	const contract = resolveContract(parsed.name, targetLevel, exact);
	if (!contract) {
		if (exact) throw new Error(`command not found: ${parsed.name}@${targetLevel}`);
		return false;
	}

	if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
		renderContractHelp(contract);
		return true;
	}

	await runContractHandler(contract, args, targetLevel);
	return true;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
	const [rawCommand, ...args] = argv;
	const parsedCommand = parseCommandToken(rawCommand);
	if (parsedCommand && (await maybeRunContractCommand(parsedCommand, args))) return;
	const command = parsedCommand?.name;

	const io = createConsoleIo();
	try {
		await runBuiltinCli(command, args, io);
	} finally {
		io.close();
	}
}

async function runBuiltinCli(
	command: string | undefined,
	args: string[],
	io: CommandIo,
): Promise<void> {
	const helpOnly = args.length === 1 && (args[0] === "-h" || args[0] === "--help");
	if (command !== undefined && helpOnly && isContractedCommand(command)) {
		printCommandHelp(command, io);
		return;
	}

	switch (command) {
		case "version":
		case "--version":
		case "-v":
			io.log(version);
			break;
		case "__prove-host":
			await proveHost(args);
			break;
		case undefined:
		case "help":
		case "--help":
		case "-h":
			io.log(renderTopLevelHelpText());
			break;
		default:
			if (command !== undefined && (await runLegacyCommand(command, args, io))) return;
			io.err(`Unknown command: ${command}\n\n${renderTopLevelHelpText()}`);
			process.exit(1);
	}
}
