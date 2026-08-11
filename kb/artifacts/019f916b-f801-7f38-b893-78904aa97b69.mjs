// Migration script for kb doc 019f916b-f800-723d-b096-07d4300ff28a.
//
// Converts a compatibility-level 0 bridge into the level-1 checked-in
// `.nosedive/config.yaml` shape and copies legacy backlog effort files into KB.
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parse, stringify } from "yaml";

const KNOWN_BASE_KEYS = ["workspace", "backlog", "kb", "home-branch", "work-branch-prefix"];

const DEFAULT_BASE = {
	workspace: "./workspace",
	backlog: "./backlog",
	kb: "./kb",
	"home-branch": "main",
	"work-branch-prefix": "work/",
};

function displayPath(path) {
	return path.replaceAll("\\", "/");
}

function writeFileAtomic(path, content) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}

function gitOutput(bridgeDir, args) {
	try {
		return execFileSync("git", args, {
			cwd: bridgeDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "";
	}
}

function assertManagedPathsClean(bridgeDir) {
	const dirty = [];
	for (const rel of ["kb", "backlog", ".nosedive"]) {
		const path = join(bridgeDir, rel);
		if (!existsSync(path)) continue;
		const status = gitOutput(bridgeDir, [
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--",
			rel,
		]).trim();
		if (status) dirty.push(...status.split(/\r?\n/).map((line) => `${rel}: ${line}`));
	}
	if (dirty.length > 0) {
		throw new Error(
			[
				"refusing to run L0->L1 migration because managed migration paths are dirty",
				...dirty.map((line) => `  ${line}`),
			].join("\n"),
		);
	}
}

function splitMarkdownFrontmatter(text, label) {
	if (!text.startsWith("---")) return { raw: {}, body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) throw new Error(`unterminated YAML frontmatter in ${label}`);
	const yaml = text.slice(3, end).trim();
	const bodyStart = text.indexOf("\n", end + 4);
	const body = bodyStart === -1 ? "" : text.slice(bodyStart + 1);
	const raw = parse(yaml) ?? {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`frontmatter in ${label} must be a YAML object`);
	}
	return { raw, body };
}

function pascalFromSlug(slug) {
	return slug
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join("");
}

function titleFromSlug(slug) {
	return slug
		.split("-")
		.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
		.join(" ");
}

function effortMarkdownInDir(dir, slug) {
	const path = join(dir, `${pascalFromSlug(slug)}.md`);
	return existsSync(path) && statSync(path).isFile() ? path : undefined;
}

function firstHeading(body, fallback) {
	const match = /^#\s+(.+?)\s*$/m.exec(body);
	return match?.[1]?.trim() || fallback;
}

function uuidLike(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function scalarString(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function trimLeadingDotSlash(value) {
	return value.replace(/^\.?[\\/]+/, "");
}

function configuredBacklogCandidates(legacy) {
	const candidates = [];
	const configured = scalarString(legacy.backlog);
	if (configured) candidates.push(trimLeadingDotSlash(configured));
	candidates.push("backlog", "efforts");
	return [...new Set(candidates)];
}

function discoverBacklogSource(bridgeDir, legacy) {
	for (const rel of configuredBacklogCandidates(legacy)) {
		const path = join(bridgeDir, rel);
		if (existsSync(path) && statSync(path).isDirectory()) return { rel, path };
	}
	return undefined;
}

function walkBacklogNode(dir, slug, ancestors, nearestParent, mintUuid) {
	const path = effortMarkdownInDir(dir, slug);
	const chain = [slug, ...ancestors].join(".");
	const entries = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name));

	let node;
	if (path) {
		const text = readFileSync(path, "utf8");
		const { raw, body } = splitMarkdownFrontmatter(text, displayPath(path));
		const id = scalarString(raw.id)?.trim() || mintUuid();
		if (!uuidLike(id)) throw new Error(`invalid effort id in ${displayPath(path)}: ${id}`);
		node = {
			id,
			path,
			sourceRel: relative(dirRoot, path).replaceAll("\\", "/"),
			slug,
			chain,
			title: firstHeading(body, titleFromSlug(slug)),
			raw,
			body,
			parent: nearestParent,
			children: [],
		};
	}

	const parentForChildren = node ?? nearestParent;
	const topEfforts = [];
	const childResults = [];
	for (const entry of entries) {
		const child = walkBacklogNode(
			join(dir, entry.name),
			entry.name,
			[slug, ...ancestors],
			parentForChildren,
			mintUuid,
		);
		childResults.push(child);
		if (node) node.children.push(...child.topEfforts);
		else if (nearestParent) nearestParent.children.push(...child.topEfforts);
		else topEfforts.push(...child.topEfforts);
	}

	const children = childResults
		.filter((child) => child.topEfforts.length > 0)
		.map((child) => child.displayNode);
	return node
		? { topEfforts: [node], displayNode: { kind: "effort", effort: node, children } }
		: { topEfforts, displayNode: { kind: "group", slug, children } };
}

let dirRoot = "";

function flattenEffort(node) {
	return [node, ...node.children.flatMap(flattenEffort)];
}

function collectEfforts(source, mintUuid) {
	dirRoot = source.path;
	const top = readdirSync(source.path, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name));
	const topEfforts = [];
	const displayNodes = [];
	for (const entry of top) {
		const result = walkBacklogNode(
			join(source.path, entry.name),
			entry.name,
			[],
			undefined,
			mintUuid,
		);
		topEfforts.push(...result.topEfforts);
		if (result.topEfforts.length > 0) displayNodes.push(result.displayNode);
	}
	const all = topEfforts.flatMap(flattenEffort);
	const seen = new Set();
	return {
		all: all.filter((effort) => {
			if (seen.has(effort.id)) throw new Error(`duplicate effort id ${effort.id}`);
			seen.add(effort.id);
			return true;
		}),
		topEfforts,
		displayNodes,
	};
}

function parseLinks(rawLinks, label) {
	if (rawLinks === undefined || rawLinks === null) return [];
	if (!Array.isArray(rawLinks)) throw new Error(`invalid links in ${label}: expected a YAML list`);
	return rawLinks.map((link, index) => {
		const itemLabel = `${label} links[${index}]`;
		if (typeof link === "string") return { id: linkIdFromTarget(link.trim()) };
		if (!link || typeof link !== "object" || Array.isArray(link)) {
			throw new Error(`invalid link entry in ${itemLabel}: expected bare id or one-key object`);
		}
		const keys = Object.keys(link);
		if (keys.length !== 1) throw new Error(`invalid link entry in ${itemLabel}: expected one id key`);
		const id = linkIdFromTarget(keys[0].trim());
		const value = link[keys[0]];
		if (value === null || value === undefined) return { id };
		if (typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`invalid link entry in ${itemLabel}: value must be a YAML object`);
		}
		return {
			id,
			rel: scalarString(value.rel)?.trim(),
			anchor: scalarString(value.anchor)?.trim(),
		};
	});
}

function linkIdFromTarget(target) {
	const match = /^kb\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i.exec(
		target,
	);
	return match?.[1]?.toLowerCase() ?? target;
}

function mergeLinks(...groups) {
	const links = [];
	const seen = new Set();
	for (const link of groups.flat()) {
		if (!link.id) continue;
		const key = `${link.id}\0${link.rel ?? ""}\0${link.anchor ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		links.push(link);
	}
	return links;
}

function linkToYaml(link) {
	const target = uuidLike(link.id) ? `kb/${link.id}.md` : link.id;
	if (!link.rel && !link.anchor) return target;
	const value = {};
	if (link.rel) value.rel = link.rel;
	if (link.anchor) value.anchor = link.anchor;
	return { [target]: value };
}

function loadMigrationKbDocs(kbDir) {
	if (!existsSync(kbDir)) return [];
	return readdirSync(kbDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => {
			const path = join(kbDir, entry.name);
			const { raw, body } = splitMarkdownFrontmatter(readFileSync(path, "utf8"), path);
			return {
				path,
				body,
				raw,
				id: scalarString(raw.id)?.trim(),
				kind: scalarString(raw.kind)?.trim(),
				name: scalarString(raw.name)?.trim(),
				meta: raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta) ? raw.meta : {},
			};
		});
}

function repoCloud(doc) {
	const remotes = doc.meta.remotes;
	if (!remotes || typeof remotes !== "object" || Array.isArray(remotes)) return undefined;
	return scalarString(remotes.cloud)?.trim();
}

function gitRemotes(bridgeDir) {
	return [
		...new Set(
			gitOutput(bridgeDir, ["remote", "-v"])
				.split(/\r?\n/)
				.map((line) => line.trim().split(/\s+/)[1])
				.filter(Boolean),
		),
	];
}

function webUrlFromRemote(remote) {
	const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(remote);
	if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
	const https = /^(https?:\/\/.+?)(?:\.git)?$/.exec(remote);
	return https?.[1];
}

function renderDoc(frontmatter, body) {
	return `---\n${stringify(frontmatter, { collectionStyle: "block", lineWidth: 0 }).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function plannedWrite(path, content, sourceRel, writes) {
	if (existsSync(path)) {
		const existing = readFileSync(path, "utf8");
		if (existing !== content)
			throw new Error(`refusing to overwrite existing different kb doc: ${displayPath(path)}`);
		return;
	}
	writes.push({ path, content, sourceRel });
}

function ensureBridgeRepoDoc(bridgeDir, kbDir, kbDocs, writes, mintUuid) {
	const remotes = gitRemotes(bridgeDir);
	const existing = kbDocs.find((doc) => doc.kind === "repo" && remotes.includes(repoCloud(doc)));
	if (existing?.id) return { id: existing.id, status: "reused", remotes };

	const id = mintUuid();
	const name = basename(bridgeDir);
	const cloud = remotes[0];
	const meta = {
		path: "workspace/__self",
		remotes: {
			local: bridgeDir,
		},
	};
	if (cloud) {
		meta.remotes.cloud = cloud;
		const url = webUrlFromRemote(cloud);
		if (url) meta.url = url;
	}
	const doc = renderDoc(
		{
			kind: "repo",
			id,
			name,
			gist: `Bridge repo ${name}.`,
			meta,
		},
		`# ${name}\n\nBridge repository for ${name}.\n`,
	);
	plannedWrite(join(kbDir, `${id}.md`), doc, "(bridge repo)", writes);
	return { id, status: "created", remotes };
}

function repoLookup(kbDocs) {
	const repos = kbDocs.filter((doc) => doc.kind === "repo" && doc.id);
	return {
		resolve(ref, label) {
			const byId = repos.filter((doc) => doc.id === ref);
			if (byId.length === 1) return byId[0].id;
			const byName = repos.filter((doc) => doc.name === ref);
			if (byName.length === 1) return byName[0].id;
			if (byName.length > 1) {
				throw new Error(`repo name is ambiguous in ${label}: ${ref} (${byName.map((doc) => doc.id).join(", ")})`);
			}
			throw new Error(`repo not found in ${label}: ${ref}`);
		},
	};
}

function parseLegacyRepoRef(entry) {
	const scalar = scalarString(entry)?.trim();
	if (!scalar) return undefined;
	const [beforeColon] = scalar.split(":");
	const [beforeAt] = beforeColon.split("@");
	return beforeAt.trim();
}

function effortScopes(effort, lookup) {
	const repos = effort.raw.repos;
	if (repos === undefined || repos === null) return [];
	if (!Array.isArray(repos))
		throw new Error(`invalid repos in ${displayPath(effort.path)}: expected a YAML list`);
	const scopes = [];
	for (const entry of repos) {
		const ref = parseLegacyRepoRef(entry);
		if (!ref) continue;
		const id = lookup.resolve(ref, effort.path);
		if (!scopes.includes(id)) scopes.push(id);
	}
	return scopes;
}

function effortFrontmatter(effort, lookup) {
	const meta = { ...effort.raw };
	delete meta.id;
	delete meta.kind;
	delete meta.gist;
	delete meta.repos;
	delete meta.scopes;
	delete meta.links;

	const existingLinks = parseLinks(effort.raw.links, effort.path);
	const generated = [];
	if (effort.parent) generated.push({ id: effort.parent.id, rel: "parent" });
	for (const child of effort.children) generated.push({ id: child.id, rel: "child" });

	const fm = {
		// The kind seed-L2-feats used to rewrite this to. That migration is
		// retired, so this is now the only place an L0 bridge's efforts get named.
		kind: "feat",
		id: effort.id,
		name: effort.chain,
		gist: scalarString(effort.raw.gist) ?? "",
	};
	const scopes = effortScopes(effort, lookup);
	if (scopes.length > 0) fm.scopes = scopes;
	const links = mergeLinks(existingLinks, generated);
	if (links.length > 0) fm.links = links.map(linkToYaml);
	if (Object.keys(meta).length > 0) fm.meta = meta;
	return fm;
}

function renderEffortDocs(efforts, lookup, kbDir, writes) {
	for (const effort of efforts) {
		const doc = renderDoc(effortFrontmatter(effort, lookup), effort.body);
		plannedWrite(join(kbDir, `${effort.id}.md`), doc, effort.sourceRel, writes);
	}
}

function appendBacklogEffortLine(lines, effort, depth = 0) {
	const indent = "  ".repeat(depth);
	const gist = scalarString(effort.raw.gist) ?? "";
	lines.push(`${indent}- [${effort.title}](${effort.id}.md): ${gist}`);
}

function appendBacklogDisplayNode(lines, node, depth = 0) {
	if (node.kind === "group") {
		if (depth === 0) {
			if (lines.at(-1) !== "") lines.push("");
			lines.push(`### ${titleFromSlug(node.slug)}`, "");
			for (const child of node.children) appendBacklogDisplayNode(lines, child, 0);
			if (lines.at(-1) !== "") lines.push("");
			return;
		}
		lines.push(`${"  ".repeat(depth)}- **${titleFromSlug(node.slug)}**`);
		for (const child of node.children) appendBacklogDisplayNode(lines, child, depth + 1);
		return;
	}

	appendBacklogEffortLine(lines, node.effort, depth);
	for (const child of node.children) appendBacklogDisplayNode(lines, child, depth + 1);
}

function renderBacklogMemo(kbDir, cwdName, topEfforts, displayNodes, writes, mintUuid) {
	const id = mintUuid();
	const links = topEfforts.map((effort) => ({ [`kb/${effort.id}.md`]: { rel: "main-effort" } }));
	const lines = ["# Backlog", "", "## Current efforts", ""];
	for (const node of displayNodes) appendBacklogDisplayNode(lines, node);
	while (lines.at(-1) === "") lines.pop();
	const doc = renderDoc(
		{
			kind: "memo",
			id,
			name: `backlog.${cwdName}`,
			gist: `Current backlog for ${cwdName}.`,
			links,
		},
		`${lines.join("\n")}\n`,
	);
	plannedWrite(join(kbDir, `${id}.md`), doc, "(backlog index)", writes);
	return id;
}

function baseConfigFromLegacy(legacy, backlogMemoId) {
	const remaining = { ...legacy };
	delete remaining["pilot-name"];
	delete remaining["pilot-email"];
	delete remaining.current;

	const base = { "compatibility-level": 1 };
	for (const key of KNOWN_BASE_KEYS) {
		if (key in remaining) {
			base[key] = remaining[key];
			delete remaining[key];
		} else if (key in DEFAULT_BASE) {
			base[key] = DEFAULT_BASE[key];
		}
	}
	if (backlogMemoId) base.backlog = backlogMemoId;
	Object.assign(base, remaining);
	return base;
}

export function migrate(ctx) {
	const bridgeDir = ctx.bridgeDir;
	if (typeof ctx.mintUuid !== "function") throw new Error("migration context is missing mintUuid()");
	const mintUuid = ctx.mintUuid;
	const legacyPath = join(bridgeDir, ".nosediverc");
	const legacy = existsSync(legacyPath) ? (parse(readFileSync(legacyPath, "utf8")) ?? {}) : {};
	if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
		throw new Error(`${displayPath(legacyPath)} must contain a YAML object`);
	}

	assertManagedPathsClean(bridgeDir);

	const source = discoverBacklogSource(bridgeDir, legacy);
	const kbRel = trimLeadingDotSlash(scalarString(legacy.kb) ?? DEFAULT_BASE.kb);
	const kbDir = join(bridgeDir, kbRel);
	const writes = [];
	const copiedFiles = [];

	let effortCount = 0;
	let backlogMemoId;
	let bridgeRepo;
	if (source) {
		const kbDocs = loadMigrationKbDocs(kbDir);
		bridgeRepo = ensureBridgeRepoDoc(bridgeDir, kbDir, kbDocs, writes, mintUuid);
		const { all, topEfforts, displayNodes } = collectEfforts(source, mintUuid);
		const withPlannedRepo = kbDocs.concat(
			writes.map((write) => {
				const { raw } = splitMarkdownFrontmatter(write.content, write.path);
				return { path: write.path, raw, id: raw.id, kind: raw.kind, name: raw.name, meta: raw.meta ?? {} };
			}),
		);
		const lookup = repoLookup(withPlannedRepo);
		renderEffortDocs(all, lookup, kbDir, writes);
		backlogMemoId = renderBacklogMemo(
			kbDir,
			basename(bridgeDir),
			topEfforts,
			displayNodes,
			writes,
			mintUuid,
		);
		effortCount = all.length;
	}

	const config = stringify(baseConfigFromLegacy(legacy, backlogMemoId), {
		collectionStyle: "block",
		lineWidth: 0,
	});
	writes.push({ path: join(bridgeDir, ".nosedive", "config.yaml"), content: config, sourceRel: "(config)" });

	for (const write of writes) {
		writeFileAtomic(write.path, write.content);
		if (write.sourceRel && !write.sourceRel.startsWith("(")) copiedFiles.push(write.sourceRel);
	}
	if (existsSync(legacyPath)) rmSync(legacyPath, { force: true });

	return {
		sourceDir: source?.rel,
		copiedFiles,
		effortCount,
		backlogMemoId,
		bridgeRepo,
		manualCleanup: source
			? `Legacy ${source.rel}/ remains after copying; remove it manually after reviewing the KB migration.`
			: undefined,
	};
}
