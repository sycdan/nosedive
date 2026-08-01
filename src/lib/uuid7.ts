import { randomBytes } from "node:crypto";

export const UUID7_MAX_TIMESTAMP_MS = 0xffffffffffff;

export function parseMintTimestamp(value: string): number {
	if (/^\d+$/.test(value)) return Number(value);
	return Date.parse(value);
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

export function mintUuid7Lines(args: string[], now = Date.now()): string[] {
	const [firstArg, secondArg] = args;
	const baseMs = firstArg ? parseMintTimestamp(firstArg) : now;
	const count = secondArg ? Number(secondArg) : 1;

	if (!Number.isFinite(baseMs) || baseMs < 0 || !Number.isInteger(baseMs)) {
		throw new Error("mint: invalid timestamp (use ISO date string or Unix milliseconds)");
	}
	if (!Number.isInteger(count) || count < 1 || count > 1000) {
		throw new Error("mint: invalid count (must be an integer between 1 and 1000)");
	}
	if (baseMs > UUID7_MAX_TIMESTAMP_MS || baseMs + (count - 1) > UUID7_MAX_TIMESTAMP_MS) {
		throw new Error("mint: timestamp out of UUIDv7 range");
	}

	const lines: string[] = [];
	for (let i = 0; i < count; i += 1) lines.push(uuid7AtMs(baseMs + i));
	return lines;
}
