import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createImplRegistry, type CommandImplRegistry } from "./impl/index.js";
import { setCommandIoFactory } from "./impl/commandAdapter.js";
import {
	isContractedCommand,
	packageContractDoc,
	printCommandHelp,
	renderContractHelpText,
	renderTopLevelHelpText,
	resolveContract,
	type ContractDoc,
} from "./contractDocs.js";
import {
	aheadOfBridgeWarning,
	createStreamingIo,
	CURRENT_COMPATIBILITY_LEVEL,
	formatPath,
	isInsideDir,
	levelGateError,
	maybeBridgeCompatibilityLevel,
	packageRoot,
	resolveFrom,
	setCommandHelpPrinter,
	setTopLevelHelpRenderer,
	unsafeLinkPath,
} from "./lib/commands.js";
import { lib, type CommandLibRegistry } from "./lib/index.js";
import { executePrompt } from "./lib/promptExecution.js";

export { isContractedCommand, printCommandHelp, renderTopLevelHelpText } from "./contractDocs.js";

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

export function parseCommandToken(command: string | undefined): ParsedCommand | undefined {
	if (command === undefined) return undefined;
	const match = /^(.+)@([0-9]+)$/.exec(command);
	if (!match) return { name: command };
	return {
		name: match[1]!,
		explicitCompatibilityLevel: Number.parseInt(match[2]!, 10),
	};
}

setCommandHelpPrinter(printCommandHelp);
setTopLevelHelpRenderer(renderTopLevelHelpText);

function renderContractHelp(contract: ContractDoc): void {
	const help = renderContractHelpText(contract);
	if (help) console.log(help);
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
