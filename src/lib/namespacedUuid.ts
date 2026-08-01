import { createHash } from "node:crypto";

function uuidBytes(uuid: string): Buffer {
	const hex = uuid.replace(/-/g, "");
	if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`invalid UUID namespace: ${uuid}`);
	return Buffer.from(hex, "hex");
}

function formatUuid(bytes: Buffer): string {
	const hex = bytes.toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

export function namespacedUuid(namespace: string, name: string): string {
	const bytes = createHash("sha1")
		.update(uuidBytes(namespace))
		.update(name)
		.digest()
		.subarray(0, 16);

	// UUIDv5: SHA-1 namespace/name hash with version (0101) and variant (10).
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;

	return formatUuid(bytes);
}
