import { isAbsolute, relative, resolve } from "node:path";

import { toPosixPath } from "./coreParsing.js";

function rewriteRelativeDestination(destination: string, sourceDir: string, cwd: string): string {
	if (
		!destination ||
		destination.startsWith("#") ||
		destination.startsWith("?") ||
		destination.startsWith("//") ||
		isAbsolute(destination) ||
		/^[a-z][a-z\d+.-]*:/i.test(destination)
	) {
		return destination;
	}
	const suffixAt = destination.search(/[?#]/);
	const path = suffixAt === -1 ? destination : destination.slice(0, suffixAt);
	const suffix = suffixAt === -1 ? "" : destination.slice(suffixAt);
	const rendered = relative(cwd, resolve(sourceDir, path)) || ".";
	return `${toPosixPath(rendered)}${suffix}`;
}

export function rewriteMarkdownLinks(body: string, sourceDir: string, cwd: string): string {
	let fence: string | undefined;
	return body
		.split(/(?<=\n)/)
		.map((line) => {
			const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
			if (fenceMatch) {
				const marker = fenceMatch[1]!;
				if (!fence) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
				return line;
			}
			if (fence || /^(?: {4}|\t)/.test(line)) return line;

			let rendered = "";
			for (let index = 0; index < line.length;) {
				if (line[index] === "`") {
					const ticks = line.slice(index).match(/^`+/)![0];
					const end = line.indexOf(ticks, index + ticks.length);
					const next = end === -1 ? line.length : end + ticks.length;
					rendered += line.slice(index, next);
					index = next;
					continue;
				}
				if (line[index] !== "[" || line[index - 1] === "!" || line[index - 1] === "\\") {
					rendered += line[index++];
					continue;
				}

				const labelEnd = line.indexOf("](", index + 1);
				if (labelEnd === -1) {
					rendered += line[index++];
					continue;
				}
				let destinationStart = labelEnd + 2;
				while (/\s/.test(line[destinationStart] ?? "")) destinationStart++;
				const angled = line[destinationStart] === "<";
				if (angled) destinationStart++;
				let destinationEnd = destinationStart;
				let depth = 0;
				while (destinationEnd < line.length) {
					const char = line[destinationEnd]!;
					if (char === "\\") {
						destinationEnd += 2;
						continue;
					}
					if (angled ? char === ">" : (char === ")" && depth === 0) || /\s/.test(char)) break;
					if (char === "(") depth++;
					if (char === ")") depth--;
					destinationEnd++;
				}
				const destination = line.slice(destinationStart, destinationEnd);
				if (!destination) {
					rendered += line[index++];
					continue;
				}
				rendered += line.slice(index, destinationStart);
				rendered += rewriteRelativeDestination(destination, sourceDir, cwd);
				index = destinationEnd;
			}
			return rendered;
		})
		.join("");
}
