import { readFileSync } from "node:fs";

/**
 * The whole of fd 0, read at once, with CRLF normalized away and the ends
 * trimmed.
 *
 * A terminal is refused rather than read. With no pipe there is nothing to
 * read and the command would wait forever, which looks like a hang and not
 * like a usage error -- the one way stdin can be worse than a flag, and the
 * cheapest to close. The refusal is the caller's `hint`, because only the
 * caller knows the pipe form the pilot should have typed.
 */
export function readStdinText(hint: string): string {
	if (process.stdin.isTTY) throw new Error(hint);
	// CRLF would otherwise survive into the document and litter every later diff.
	return readFileSync(0, "utf8").replaceAll("\r\n", "\n").trim();
}
