// Migration script for kb doc 019fda4e-b14f-7bb9-b751-20b2106e3374.
//
// Converts an L1 backlog memo's rendered body tree into canonical rel-role
// links without relying on kind: feat or name slug chains.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";

const DEFAULT_KB = "./kb";
const MANAGED_BACKLOG_KINDS = new Set(["repo", "dive"]);
const TREE_DOC_RELS = new Set([
	"parent",
	"child",
	"parent-effort",
	"child-effort",
	"parent.feat",
	"child.feat",
]);

function displayPath(path) {
	return path.replaceAll("\\", "/");
}

function writeFileAtomic(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

function scalarString(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function splitMarkdownFrontmatter(text, label) {
	if (!text.startsWith("---")) throw new Error(`${label} is missing YAML frontmatter`);
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	if (!match) throw new Error(`${label} has unterminated YAML frontmatter`);
	const raw = parse(match[1] ?? "") ?? {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`frontmatter in ${label} must be a YAML object`);
	}
	return { raw, body: text.slice(match[0].length) };
}

function renderDoc(raw, body) {
	return `---\n${stringify(raw, { collectionStyle: "block", lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

function resolveFrom(base, path) {
	return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function readConfig(bridgeDir) {
	const path = join(bridgeDir, ".nosedive", "config.yaml");
	const raw = parse(readFileSync(path, "utf8")) ?? {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${displayPath(path)} must contain a YAML object`);
	}
	const kb = scalarString(raw.kb) ?? DEFAULT_KB;
	const backlog = scalarString(raw.backlog);
	if (!backlog) throw new Error("L1->L2 migration requires a configured backlog memo id");
	return { path, kbDir: resolveFrom(bridgeDir, kb), backlog };
}

function uuidLike(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isInsideDir(parent, child) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function loadDoc(path, bridgeDir) {
	const text = readFileSync(path, "utf8");
	const { raw, body } = splitMarkdownFrontmatter(text, displayPath(path));
	return {
		path,
		relPath: displayPath(relative(bridgeDir, path)),
		raw,
		body,
		id: scalarString(raw.id)?.trim(),
		kind: scalarString(raw.kind)?.trim(),
	};
}

function loadKbDocs(kbDir, bridgeDir) {
	if (!existsSync(kbDir) || !statSync(kbDir).isDirectory()) {
		throw new Error(`configured kb directory not found: ${displayPath(kbDir)}`);
	}
	const byId = new Map();
	const byPath = new Map();
	const entries = [];
	for (const entry of readdirSync(kbDir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
		const doc = loadDoc(join(kbDir, entry.name), bridgeDir);
		entries.push(doc);
		byPath.set(resolve(doc.path).toLowerCase(), doc);
		if (doc.id) byId.set(doc.id.toLowerCase(), doc);
	}
	return { byId, byPath, docs: entries };
}

function targetIdFromPath(target) {
	const match = /^kb\/([0-9a-f-]{36})\.md$/i.exec(target);
	if (match) return match[1].toLowerCase();
	return undefined;
}

function linkTarget(link) {
	if (typeof link === "string") return link.trim();
	if (!link || typeof link !== "object" || Array.isArray(link)) return undefined;
	const keys = Object.keys(link);
	return keys.length === 1 ? keys[0] : undefined;
}

function linkRel(link) {
	if (!link || typeof link !== "object" || Array.isArray(link)) return undefined;
	const target = linkTarget(link);
	if (!target) return undefined;
	const value = link[target];
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return scalarString(value.rel)?.trim();
}

function linkTargetId(link) {
	const target = linkTarget(link);
	if (!target) return undefined;
	return targetIdFromPath(target) ?? target;
}

function canonicalFeatRel(rel) {
	// `main-effort` is what the L0->L1 seed wrote for every root, so it is a
	// machine default rather than the pilot's filing, and L2 renders it as
	// `## Current`. Any other rel is the pilot's and only gains the role.
	if (!rel || rel === "main-effort") return "current.feat";
	return rel.endsWith(".feat") ? rel : `${rel}.feat`;
}

function parseBacklogBodyTree(body, memoPath, kbDir, byId, byPath) {
	const nodes = [];
	const stack = [];
	const bullet = /^(\s*)-\s+\[([^\]]+)]\(([^)]+)\)/;
	for (const [index, line] of body.split(/\r?\n/).entries()) {
		const match = bullet.exec(line);
		if (!match) continue;
		const indent = match[1].replaceAll("\t", "  ").length;
		const target = match[3].trim();
		if (/^[a-z]+:/i.test(target)) continue;
		const targetNoAnchor = target.split("#")[0];
		const docPath = resolveFrom(dirname(memoPath), targetNoAnchor);
		const normalizedDocPath = normalize(docPath);
		if (!isInsideDir(kbDir, normalizedDocPath)) {
			throw new Error(`backlog link escapes kb directory on line ${index + 1}: ${target}`);
		}
		const id = targetIdFromPath(`kb/${targetNoAnchor}`) ?? targetNoAnchor.replace(/\.md$/i, "");
		const doc = byPath.get(resolve(normalizedDocPath).toLowerCase()) ?? byId.get(id.toLowerCase());
		if (!doc) throw new Error(`backlog body link points at missing kb doc on line ${index + 1}: ${target}`);
		if (MANAGED_BACKLOG_KINDS.has(doc.kind ?? "")) {
			throw new Error(`backlog body link points at managed ${doc.kind} doc: ${doc.relPath}`);
		}
		if (!doc.id) throw new Error(`backlog body link points at kb doc with no id: ${doc.relPath}`);
		const node = { id: doc.id.toLowerCase(), doc, indent, children: [], parent: undefined };
		while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();
		if (stack.length > 0) {
			node.parent = stack.at(-1);
			node.parent.children.push(node);
		}
		stack.push(node);
		nodes.push(node);
	}
	const seen = new Set();
	for (const node of nodes) {
		if (seen.has(node.id)) throw new Error(`backlog body lists kb doc more than once: ${node.doc.relPath}`);
		seen.add(node.id);
	}
	return nodes;
}

function existingRelByTarget(rawLinks, targetIds) {
	const rels = new Map();
	if (!Array.isArray(rawLinks)) return rels;
	for (const link of rawLinks) {
		const id = linkTargetId(link);
		if (!id || !targetIds.has(id.toLowerCase())) continue;
		const rel = linkRel(link);
		if (rel) rels.set(id.toLowerCase(), rel);
	}
	return rels;
}

function linkEntry(id, rel) {
	return { [`kb/${id}.md`]: { rel } };
}

function rewriteBacklogLinks(memo, nodes) {
	const nodeIds = new Set(nodes.map((node) => node.id));
	const rootNodes = nodes.filter((node) => !node.parent);
	const existingRootRel = existingRelByTarget(memo.raw.links, new Set(rootNodes.map((node) => node.id)));
	const kept = Array.isArray(memo.raw.links)
		? memo.raw.links.filter((link) => {
				const id = linkTargetId(link)?.toLowerCase();
				return !id || !nodeIds.has(id);
			})
		: [];
	memo.raw.links = [
		...kept,
		...rootNodes.map((node) => linkEntry(node.id, canonicalFeatRel(existingRootRel.get(node.id)))),
	];
}

function rewriteTreeDocLinks(node) {
	const childIds = new Set(node.children.map((child) => child.id));
	const parentId = node.parent?.id;
	const rawLinks = Array.isArray(node.doc.raw.links) ? node.doc.raw.links : [];
	const kept = rawLinks.filter((link) => {
		const id = linkTargetId(link)?.toLowerCase();
		const rel = linkRel(link);
		if (!id || !rel) return true;
		if (TREE_DOC_RELS.has(rel) && (id === parentId || childIds.has(id))) return false;
		if (TREE_DOC_RELS.has(rel) && node.docByBodyIds?.has(id)) return false;
		return true;
	});
	const generated = [];
	if (node.parent) generated.push(linkEntry(node.parent.id, "parent.feat"));
	for (const child of node.children) generated.push(linkEntry(child.id, "child.feat"));
	const links = [...kept, ...generated];
	if (links.length > 0) node.doc.raw.links = links;
	else delete node.doc.raw.links;
}

export function migrate(ctx) {
	const bridgeDir = ctx.bridgeDir;
	const config = readConfig(bridgeDir);
	if (!uuidLike(config.backlog)) {
		return { featCount: 0 };
	}
	const { byId, byPath } = loadKbDocs(config.kbDir, bridgeDir);
	const memo = byId.get(config.backlog.toLowerCase());
	if (!memo) throw new Error(`bridge backlog memo not found: ${config.backlog}`);
	const nodes = parseBacklogBodyTree(memo.body, memo.path, config.kbDir, byId, byPath);
	const bodyIds = new Set(nodes.map((node) => node.id));
	for (const node of nodes) node.docByBodyIds = bodyIds;

	rewriteBacklogLinks(memo, nodes);
	for (const node of nodes) rewriteTreeDocLinks(node);

	const touched = new Map([[memo.path, memo]]);
	for (const node of nodes) touched.set(node.doc.path, node.doc);
	for (const doc of touched.values()) writeFileAtomic(doc.path, renderDoc(doc.raw, doc.body));

	return { featCount: nodes.length, backlogMemoId: memo.id };
}
