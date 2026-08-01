import { UUID7_MAX_TIMESTAMP_MS, mintUuid7Lines, parseMintTimestamp, uuid7AtMs } from "./uuid7.js";
import { namespacedUuid } from "./namespacedUuid.js";

export { UUID7_MAX_TIMESTAMP_MS, mintUuid7Lines, parseMintTimestamp, uuid7AtMs };
export { namespacedUuid };

export const lib = {
	UUID7_MAX_TIMESTAMP_MS,
	mintUuid7Lines,
	namespacedUuid,
	parseMintTimestamp,
	uuid7AtMs,
} as const;

export type CommandLibRegistry = typeof lib;
