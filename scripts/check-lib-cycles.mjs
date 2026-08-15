import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib");
const files = readdirSync(root)
	.filter((file) => file.endsWith(".ts"))
	.sort();
const graph = new Map(files.map((file) => [file, []]));

for (const file of files) {
	const text = readFileSync(resolve(root, file), "utf8");
	const emitted = ts.transpileModule(text, {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
		fileName: file,
	}).outputText;
	const edgePattern = /(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?["'](\.\/.+?)["']/g;
	for (const match of emitted.matchAll(edgePattern)) {
		const specifier = match[1];
		const target = `${basename(specifier, ".js")}.ts`;
		if (graph.has(target)) graph.get(file).push(target);
	}
}

const cycles = [];
const visited = new Set();
const active = new Set();
const stack = [];

function visit(file) {
	if (active.has(file)) {
		const start = stack.indexOf(file);
		cycles.push([...stack.slice(start), file]);
		return;
	}
	if (visited.has(file)) return;
	active.add(file);
	stack.push(file);
	for (const target of graph.get(file)) visit(target);
	stack.pop();
	active.delete(file);
	visited.add(file);
}

for (const file of files) visit(file);

const edges = [...graph.values()].reduce((count, targets) => count + targets.length, 0);
console.log(`Scanned ${files.length} modules and ${edges} internal imports.`);
if (cycles.length > 0) {
	for (const cycle of cycles) console.log(`Cycle: ${cycle.join(" -> ")}`);
	process.exitCode = 1;
} else {
	console.log("No cycles found.");
}
