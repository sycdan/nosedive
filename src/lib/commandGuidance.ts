import { readFileSync } from "node:fs";

import { formatPath, parseMarkdownDoc } from "./coreParsing.js";

const AGENT_GUIDANCE_KEY = "agent-guidance";

/**
 * Returns the closing lines a command prints, read from the command doc the router
 * actually resolved rather than from a constant beside the code.
 *
 * Two copies of the same text can drift, so we store guidance in the command doc rather
 * than in a constant. This allows the command to be versioned separately from the code.
 */
export function readAgentGuidance(commandDocPath: string | undefined): string[] {
	if (!commandDocPath) throw new Error("needs a resolved command doc, and got none");
	const label = formatPath(commandDocPath);
	const doc = parseMarkdownDoc(readFileSync(commandDocPath, "utf8"), label);
	const guidance = (doc.fm.nestedLists.meta?.[AGENT_GUIDANCE_KEY] ?? []).filter((line) =>
		line.trim(),
	);
	if (guidance.length === 0) throw new Error(`command ${label} has no meta.${AGENT_GUIDANCE_KEY}`);
	return guidance;
}
