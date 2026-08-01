import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function frontmatterish(text) {
	const values = {};
	for (const line of text.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
		if (match) values[match[1]] = match[2];
	}
	return values;
}

function projectId() {
	const ref = frontmatterish(readFileSync(resolve(root, ".nosedive-ref"), "utf8"));
	if (!ref.id) throw new Error(".nosedive-ref is missing id");
	return ref.id;
}

function uuidBytes(uuid) {
	const hex = uuid.replace(/-/g, "");
	if (!/^[0-9a-f]{32}$/i.test(hex)) {
		throw new Error(`namespace id must be a UUID: ${uuid}`);
	}
	return Buffer.from(hex, "hex");
}

function formatUuid(bytes) {
	const hex = bytes.toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

export function namespacedUuid(namespace, name) {
	const bytes = createHash("sha1")
		.update(uuidBytes(namespace))
		.update(name)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	return formatUuid(bytes);
}

export function parseCommandToken(commandToken) {
	const match = /^(.+)@([0-9]+)$/.exec(String(commandToken ?? ""));
	if (!match) throw new Error("usage: node scripts/command-identifiers.mjs <command>@<level>");
	return {
		command: match[1],
		level: Number.parseInt(match[2], 10),
	};
}

export function camelIdentifierPart(value) {
	const leadingUnderscores = /^_*/.exec(value)?.[0] ?? "";
	const body = value.slice(leadingUnderscores.length);
	const parts = body.split(/[^A-Za-z0-9]+/).filter(Boolean);
	const camel = parts
		.map((part, index) => {
			const lower = part.toLowerCase();
			if (index === 0) return lower;
			return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
		})
		.join("");
	return `${leadingUnderscores}${camel}`;
}

export function commandEntrypointName(command, level) {
	const parts = command.split(".");
	const action = parts[0] ?? "";
	const domains = parts.slice(1).map(camelIdentifierPart);
	return `L${level}__${[...domains, camelIdentifierPart(action)].filter(Boolean).join("_")}`;
}

export function commandDocId(command, level, namespace = projectId()) {
	return namespacedUuid(namespace, `command:${command}@${level}`);
}

export function commandImplCodename(entrypoint, functionName = "run") {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(functionName)) {
		throw new Error(`impl function name must be a JavaScript identifier: ${functionName}`);
	}
	return `${entrypoint}__${functionName}`;
}

export function commandImplId(entrypoint, functionName = "run", namespace = projectId()) {
	return `i${namespacedUuid(namespace, `impl:${commandImplCodename(entrypoint, functionName)}`).replaceAll("-", "")}`;
}

export function commandIdentifiers(commandToken, functionName = "run", namespace = projectId()) {
	const { command, level } = parseCommandToken(commandToken);
	const entrypoint = commandEntrypointName(command, level);
	const implCodename = commandImplCodename(entrypoint, functionName);
	const implId = commandImplId(entrypoint, functionName, namespace);
	return {
		command,
		level,
		commandDocId: commandDocId(command, level, namespace),
		commandDocPath: `kb/${commandDocId(command, level, namespace)}.md`,
		entrypoint,
		implFunction: functionName,
		implCodename,
		implId,
		implPath: `src/impl/${implId}.ts`,
	};
}

function printIdentifiers(commandToken, functionName = "run") {
	const ids = commandIdentifiers(commandToken, functionName);
	for (const [key, value] of Object.entries(ids)) {
		console.log(`${key}: ${value}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	printIdentifiers(process.argv[2], process.argv[3] ?? "run");
}
