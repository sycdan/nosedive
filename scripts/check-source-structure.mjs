import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "src");

/**
 * Runtime-import layers for every source module. Imports may only point down.
 *
 * The ranks are the current graph's longest-path depths rather than broad
 * subsystem names: strict layering forbids same-layer imports, and the graph
 * has real dependencies within each of the old six broad categories.
 */
export const SOURCE_LAYERS = Object.fromEntries(
	[
		[
			"impl/types.ts",
			"lib/constants.ts",
			"lib/namespacedUuid.ts",
			"lib/relGrammar.ts",
			"lib/slugs.ts",
			"lib/uuid7.ts",
		],
		[
			"impl/iab203ad1a19750cca9ba1e929218bda6.ts",
			"lib/coreParsing.ts",
			"lib/gitProcess.ts",
			"lib/index.ts",
		],
		[
			"lib/agentRunner.ts",
			"lib/diveScratch.ts",
			"lib/kbRefs.ts",
			"lib/markdownLinks.ts",
			"lib/renderPlan.ts",
		],
		["lib/kbSections.ts", "lib/managedExcludes.ts", "lib/packageBacklog.ts"],
		[
			"lib/backlogDives.ts",
			"lib/commitProvenance.ts",
			"lib/diveListing.ts",
			"lib/dropPrompt.ts",
			"lib/kbDocs.ts",
		],
		[
			"lib/appendLog.ts",
			"lib/gateResolve.ts",
			"lib/promptExecution.ts",
			"lib/repoFeatScopes.ts",
			"lib/repoWorkspaceCore.ts",
		],
		["lib/packArtifacts.ts", "lib/recordGate.ts", "lib/repoHardening.ts", "lib/repoWorktrees.ts"],
		[
			"lib/diveScopes.ts",
			"lib/drop.ts",
			"lib/gitState.ts",
			"lib/nukeApply.ts",
			"lib/provePins.ts",
			"lib/scopeHydration.ts",
		],
		[
			"impl/ia44699e5a04d577abdca9f0c813df65a.ts",
			"lib/planning.ts",
			"lib/proveCore.ts",
			"lib/recordDive.ts",
		],
		["lib/landGates.ts", "lib/packageLevels.ts", "lib/proveHostRender.ts"],
		["impl/ia7bf5107254b592caac992665c8c8e09.ts", "lib/bridgeSetupIo.ts", "lib/gateSession.ts"],
		["impl/i980e96ba3cdf5a998a775ade7dc57386.ts", "lib/commands.ts", "lib/packDive.ts"],
		["contractDocs.ts", "impl/commandAdapter.ts"],
		[
			"impl/i00671103fb8b50d89ffc60e3eb0f4745.ts",
			"impl/i0995c54d2e345db7839c9268c38c3ab0.ts",
			"impl/i140045f7fbac5a28bd78d411e4f3408c.ts",
			"impl/i186faaff79175065bcda163fa43c2b44.ts",
			"impl/i44d8b21d389052a8a4c9ba88a661e100.ts",
			"impl/i5146ad0edc5250b8a4e5f72792128cd3.ts",
			"impl/i54a65359b66f5194b66e4cad39f73de1.ts",
			"impl/i55dbde28c4d15a1f9a1cff54dc203cc8.ts",
			"impl/i61b2a0b9891f53cbbf99667ca8be6b3f.ts",
			"impl/i6859013f535f590caeb5f6e52fae1e68.ts",
			"impl/i6d6c7bdeb23b58b399661bebb311bf6c.ts",
			"impl/i72d9929a36175ba6a4a6c9eca48d3fc8.ts",
			"impl/i806df6b4c38c515fa02c2b060e021a5b.ts",
			"impl/i89ff71acfbc659628c68396a54e0c959.ts",
			"impl/i8e0c2e83a9ae562991518b059ec38950.ts",
			"impl/i97354f3aeee053d2a309e79725b49551.ts",
			"impl/iaec7a02f29625c9b98be0cbc193fe346.ts",
			"impl/ib222bfc755ad5698815b326a53cab031.ts",
			"impl/ic76b835ecbcb559080b2aee1b405babf.ts",
			"impl/ice20fe7c7cb65dbdb4a7164f5db7625f.ts",
			"impl/icffc77f091d15fc8855d0d4aef5a81c8.ts",
			"impl/id02d9d98ff0453ca871a1adc974fa5db.ts",
			"impl/id2f5b8bbdf015307867807ad3107a44c.ts",
			"impl/iea60fb735ccf53159bafc924926aa3fe.ts",
			"impl/if108b971e06e50ab8c8cf9ae00500457.ts",
			"impl/if96566c2381e5327a1296d254870157c.ts",
		],
		[
			"impl/i13819edb8475569d8906310bdb0ebc8e.ts",
			"impl/i14cbfa07d01f51e9b5aaca0451613df4.ts",
			"impl/i1c0a2194ba665e13a6bbebcf5033acaf.ts",
			"impl/i2dce2285fdf7576d8df6b705ed9eb831.ts",
			"impl/i386442ce4b2b5d0f97194ab44d54bd93.ts",
			"impl/i4902e2824ecd5d1fa7df1745486d00a9.ts",
			"impl/i56234ba315d45b719a2b0149c885d328.ts",
			"impl/i920b7cd2b81052f288b01b56dcd9ffc0.ts",
			"impl/i9a8b1978632956e69d48107f74a456d5.ts",
			"impl/ia38800e7a3cc59599adc89e43a67da27.ts",
			"impl/ia4b29088966a53d39c14a03500a73681.ts",
			"impl/ib7dc11975e685ae881068b3b92379c89.ts",
			"impl/idfa77573dddc590cb8f5f5ff784c3384.ts",
			"impl/ie4616d52d0ef552ba573e76c80480966.ts",
			"impl/if6c2c56c962256f4a9e48e095355c188.ts",
		],
		["impl/index.ts"],
		["contracts.ts"],
		["nosedive.ts"],
		["cli.ts"],
	].flatMap((paths, layer) => paths.map((path) => [path, layer])),
);

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

export function checkSourceStructure({ rootPath = sourceRoot, layers = SOURCE_LAYERS } = {}) {
	const paths = tsFiles(rootPath).sort();
	const files = new Set(paths);
	const graph = new Map(paths.map((path) => [path, []]));
	const failures = [];
	const names = new Map(paths.map((path) => [path, sourcePath(rootPath, path)]));

	for (const path of paths) {
		const name = names.get(path);
		if (!Object.hasOwn(layers, name))
			failures.push(`${name} has no declared source layer; add it to SOURCE_LAYERS.`);
	}
	for (const name of Object.keys(layers).sort()) {
		if (!files.has(resolve(rootPath, name)))
			failures.push(`SOURCE_LAYERS assigns ${name}, but that source module does not exist.`);
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
		const sourceLayer = layers[sourceName];
		for (const target of targets) {
			const targetName = names.get(target);
			const targetLayer = layers[targetName];
			if (sourceLayer === undefined || targetLayer === undefined || sourceLayer > targetLayer)
				continue;
			failures.push(
				`${sourceName} (layer ${sourceLayer}) imports ${targetName} (layer ${targetLayer}); imports must point to a strictly lower layer. Move a shared helper down or move the caller up. See kb/01a00393-d830-7922-922b-7e8216370c85.md.`,
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
