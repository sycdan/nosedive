import { readFileSync } from "node:fs";
import { parseDocument, type Document } from "yaml";

import { formatPath, parseMarkdownDoc, stringifyYaml } from "./coreParsing.js";
import { writeFileAtomic } from "./renderPlan.js";

/**
 * Patch a kb document in place: the callback edits the parsed frontmatter and
 * returns the body it wants written, and everything it did not touch survives
 * -- comments, key order, and the keys this command has never heard of.
 *
 * `record.dive` and `pack` each grew their own copy of this before the record
 * family had edit forms. They are left as they are; this is the copy the edit
 * forms share.
 */
export function editKbDoc(path: string, mutate: (doc: Document, body: string) => string): void {
	const text = readFileSync(path, "utf8");
	const parsed = parseMarkdownDoc(text, formatPath(path));
	const doc = parseDocument(text.slice(4, text.indexOf("\n---", 4)));
	if (doc.errors.length > 0) throw new Error(`invalid YAML in frontmatter in ${formatPath(path)}`);
	const body = mutate(doc, parsed.body);
	writeFileAtomic(path, ["---", stringifyYaml(doc).trimEnd(), "---", body].join("\n"));
}
