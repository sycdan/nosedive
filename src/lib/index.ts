import { namespacedUuid } from "./namespacedUuid.js";
import { UUID7_MAX_TIMESTAMP_MS, mintUuid7Lines, parseMintArgs, uuid7AtMs } from "./uuid7.js";

export { UUID7_MAX_TIMESTAMP_MS, mintUuid7Lines, namespacedUuid, parseMintArgs, uuid7AtMs };

export const lib = {
	UUID7_MAX_TIMESTAMP_MS,
	mintUuid7Lines,
	namespacedUuid,
	parseMintArgs,
	uuid7AtMs,
} as const;

export type CommandLibRegistry = typeof lib;
