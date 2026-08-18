import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
	formatPath,
	packageDocsOfKind,
	packageRoot,
	parseLinkRefs,
	parseMarkdownDoc,
	parseScopeRefs,
	toPosixPath,
	type CommandIo,
	type KbDoc,
} from "./lib/commands.js";
import { namespacedUuid } from "./lib/index.js";

const USAGE_HEADER = "Usage: nosedive <command>";

export interface ContractDoc extends KbDoc {
	body: string;
	command: string;
	compatibilityLevel: number;
	adapter: string;
	entrypoint: string;
	usage: string;
	agentsUseWhen: string;
	useInstead: string;
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
		featRef: undefined,
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

export function packageContractDoc(
	command: string,
	compatibilityLevel: number,
): ContractDoc | undefined {
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

export function packageContractDocs(): ContractDoc[] {
	const packageKbDir = join(packageRoot(), "kb");
	return packageDocsOfKind("command").map((doc) =>
		parsePackageContractDoc(join(packageKbDir, doc.filename), doc.content),
	);
}

export function resolveContract(
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

export function renderContractHelpText(contract: ContractDoc): string {
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

/**
 * The latest doc per command, deprecated or not. A deprecated command is still
 * a contracted command -- it runs, and it has to explain itself -- so the
 * deprecation filter belongs to whoever is listing a surface, not here.
 */
function latestContractDocs(): ContractDoc[] {
	const latestByCommand = new Map<string, ContractDoc>();
	for (const contract of packageContractDocs()) {
		if (contract.command.startsWith("_")) continue;
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
 *
 * Deprecation is judged on the latest doc per command, which is what
 * `scripts/update-readme-command-surface.mjs` does and why the README has
 * always been right about this. Filtering deprecated docs before reducing to
 * the latest discards only the doc carrying `use-instead` and leaves the
 * command listed under an older one that predates the decision --
 * `add-repo.effort` advertised itself under its L1 gist, which still called a
 * feat an effort.
 */
export function renderTopLevelHelpText(options?: { agents?: boolean }): string {
	const contracts = latestContractDocs().filter(
		(contract) =>
			!isDeprecatedContract(contract) && (!options?.agents || contract.agentsUseWhen.trim() !== ""),
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

export function printCommandHelp(command: string, io: CommandIo): void {
	const contract = packageContractDocs()
		.filter((doc) => doc.command === command)
		.sort((a, b) => b.compatibilityLevel - a.compatibilityLevel)[0];
	if (!contract) throw new Error(`no packaged command document for command: ${command}`);
	io.log(renderContractHelpText(contract));
}

export function isContractedCommand(command: string): boolean {
	return latestContractDocs().some((doc) => doc.command === command);
}
