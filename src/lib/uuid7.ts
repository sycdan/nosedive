import { randomBytes } from "node:crypto";

export const UUID7_MAX_TIMESTAMP_MS = 0xffffffffffff;

export interface MintOptions {
	count: number;
	baseMs: number;
}

export function uuid7AtMs(ms: number): string {
	const bytes = new Uint8Array(randomBytes(16)) as Uint8Array;
	const ts = BigInt(ms);

	bytes[0] = Number((ts >> 40n) & 0xffn);
	bytes[1] = Number((ts >> 32n) & 0xffn);
	bytes[2] = Number((ts >> 24n) & 0xffn);
	bytes[3] = Number((ts >> 16n) & 0xffn);
	bytes[4] = Number((ts >> 8n) & 0xffn);
	bytes[5] = Number(ts & 0xffn);

	// Set version (0111) and variant (10).
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

function mintOptionValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseMintArgs(args: string[], now = Date.now()): MintOptions {
	let countArg: string | undefined;
	let ms: string | undefined;
	let ts: string | undefined;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i]!;
		if (arg === "--ms" || arg === "--ts") {
			const value = mintOptionValue(args, i + 1, arg);
			if (arg === "--ms") ms = value;
			else ts = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--ms=")) {
			ms = arg.slice("--ms=".length);
			if (!ms) throw new Error("--ms requires a value");
			continue;
		}
		if (arg.startsWith("--ts=")) {
			ts = arg.slice("--ts=".length);
			if (!ts) throw new Error("--ts requires a value");
			continue;
		}
		if (arg.startsWith("--")) throw new Error(`unknown mint option: ${arg}`);
		if (countArg !== undefined) throw new Error(`unexpected mint argument: ${arg}`);
		countArg = arg;
	}

	if (ms !== undefined && ts !== undefined) throw new Error("mint: --ms and --ts are exclusive");

	const count = countArg === undefined ? 1 : Number(countArg);
	let baseMs = now;
	if (ms !== undefined) baseMs = /^\d+$/.test(ms) ? Number(ms) : Number.NaN;
	else if (ts !== undefined) baseMs = Date.parse(ts);

	if (!Number.isInteger(count) || count < 1 || count > 1000) {
		throw new Error("mint: invalid count (must be an integer between 1 and 1000)");
	}
	if (!Number.isFinite(baseMs) || baseMs < 0 || !Number.isInteger(baseMs)) {
		throw new Error(
			ms !== undefined
				? "mint: invalid --ms (use Unix milliseconds)"
				: "mint: invalid --ts (use an ISO 8601 date string)",
		);
	}
	if (baseMs > UUID7_MAX_TIMESTAMP_MS || baseMs + (count - 1) > UUID7_MAX_TIMESTAMP_MS) {
		throw new Error("mint: timestamp out of UUIDv7 range");
	}

	return { count, baseMs };
}

export function mintUuid7Lines(args: string[], now = Date.now()): string[] {
	const { count, baseMs } = parseMintArgs(args, now);
	const lines: string[] = [];
	for (let i = 0; i < count; i += 1) lines.push(uuid7AtMs(baseMs + i));
	return lines;
}
