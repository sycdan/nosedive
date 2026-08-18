import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "src");

/**
 * Architectural boundaries, ordered from reusable core to executable surface.
 *
 * A boundary may use itself and lower boundaries. Cycles remain forbidden by a
 * separate graph check, so ordinary collaboration within lib/ or impl/ does
 * not require inventing a rank for every new module.
 */
const SOURCE_BOUNDARIES = [
	{ name: "shared core", rank: 0, matches: (path) => path.startsWith("lib/") },
	{ name: "command implementation", rank: 1, matches: (path) => path.startsWith("impl/") },
	{ name: "contract discovery", rank: 1, matches: (path) => path === "contractDocs.ts" },
	{ name: "command façade", rank: 2, matches: (path) => path === "contracts.ts" },
	{ name: "CLI router", rank: 3, matches: (path) => path === "nosedive.ts" },
	{ name: "CLI entrypoint", rank: 4, matches: (path) => path === "cli.ts" },
];

export function boundaryForSource(path) {
	return SOURCE_BOUNDARIES.find((boundary) => boundary.matches(path));
}

function tsFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) return tsFiles(path);
		return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
	});
}

function sourcePath(rootPath, path) {
	return relative(rootPath, path).replaceAll("\\", "/");
}

function resolveRelativeImport(path, specifier) {
	let target = resolve(dirname(path), specifier);
	if (extname(target) === ".js") target = `${target.slice(0, -3)}.ts`;
	else if (extname(target) === "") target = `${target}.ts`;
	return target;
}

function runtimeRelativeImports(path) {
	const emitted = ts.transpileModule(readFileSync(path, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
		fileName: path,
	}).outputText;
	const imports = [];
	const edgePattern = /(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["'](\.[^"']+)["']/g;
	for (const match of emitted.matchAll(edgePattern)) imports.push(match[1]);
	return imports;
}

function cyclesIn(graph) {
	const cycles = [];
	const visited = new Set();
	const active = new Set();
	const stack = [];
	function visit(path) {
		if (active.has(path)) {
			cycles.push([...stack.slice(stack.indexOf(path)), path]);
			return;
		}
		if (visited.has(path)) return;
		active.add(path);
		stack.push(path);
		for (const target of graph.get(path) ?? []) visit(target);
		stack.pop();
		active.delete(path);
		visited.add(path);
	}
	for (const path of graph.keys()) visit(path);
	return cycles;
}

export function checkSourceStructure({
	rootPath = sourceRoot,
	boundaryFor = boundaryForSource,
} = {}) {
	const paths = tsFiles(rootPath).sort();
	const files = new Set(paths);
	const graph = new Map(paths.map((path) => [path, []]));
	const failures = [];
	const names = new Map(paths.map((path) => [path, sourcePath(rootPath, path)]));

	for (const path of paths) {
		const name = names.get(path);
		if (!boundaryFor(name))
			failures.push(`${name} has no declared source boundary; assign one deliberately.`);
	}

	for (const path of paths) {
		for (const specifier of runtimeRelativeImports(path)) {
			const target = resolveRelativeImport(path, specifier);
			if (!files.has(target)) {
				failures.push(`${names.get(path)} imports unresolved internal module ${specifier}.`);
				continue;
			}
			graph.get(path).push(target);
		}
	}

	for (const cycle of cyclesIn(graph))
		failures.push(`Source import cycle: ${cycle.map((path) => names.get(path)).join(" -> ")}.`);

	for (const [path, targets] of graph) {
		const sourceName = names.get(path);
		const sourceBoundary = boundaryFor(sourceName);
		for (const target of targets) {
			const targetName = names.get(target);
			const targetBoundary = boundaryFor(targetName);
			if (!sourceBoundary || !targetBoundary || sourceBoundary.rank >= targetBoundary.rank)
				continue;
			failures.push(
				`${sourceName} (${sourceBoundary.name}) imports ${targetName} (${targetBoundary.name}); imports may stay within a boundary or point to a lower one. Move a shared helper down or move the caller up. See kb/01a00393-d830-7922-922b-7e8216370c85.md.`,
			);
		}
	}

	return {
		failures,
		moduleCount: paths.length,
		importCount: [...graph.values()].reduce((count, targets) => count + targets.length, 0),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const result = checkSourceStructure();
	if (result.failures.length > 0) {
		console.error("source structure check failed:");
		for (const failure of result.failures) console.error(`- ${failure}`);
		process.exitCode = 1;
	} else {
		console.log(
			`source structure check passed: ${result.moduleCount} modules and ${result.importCount} internal imports.`,
		);
	}
}
