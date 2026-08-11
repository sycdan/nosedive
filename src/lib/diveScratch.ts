import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { parseMarkdownDoc } from "./coreParsing.js";

const DIVE_SCRATCH_CONCEPT_DOC_URL = new URL(
	"../kb/019feeeb-ff29-720d-ad65-0c77a2957744.md",
	import.meta.url,
);
const DIVE_ID_PLACEHOLDER = "<dive-id>";
const WORKSPACE_PLACEHOLDER = "<nosedive-workspace>";
const DIVE_SCRATCH_META_KEY = "scratch-path-template";

function diveScratchTemplate(): string {
	const doc = parseMarkdownDoc(
		readFileSync(DIVE_SCRATCH_CONCEPT_DOC_URL, "utf8"),
		"packaged dive scratch space document",
	);
	const template = doc.fm.nested.meta?.[DIVE_SCRATCH_META_KEY]?.trim();
	if (!template) {
		throw new Error(
			`packaged dive scratch space document is missing meta.${DIVE_SCRATCH_META_KEY}`,
		);
	}
	if (template.includes("\\") || !template.endsWith("/")) {
		throw new Error(
			`meta.${DIVE_SCRATCH_META_KEY} must be a slash-terminated POSIX path: ${template}`,
		);
	}

	const segments = template.slice(0, -1).split("/");
	if (
		segments[0] !== WORKSPACE_PLACEHOLDER ||
		segments.at(-1) !== DIVE_ID_PLACEHOLDER ||
		segments.some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new Error(
			`meta.${DIVE_SCRATCH_META_KEY} must be a ${WORKSPACE_PLACEHOLDER}/.../${DIVE_ID_PLACEHOLDER}/ path: ${template}`,
		);
	}
	return template;
}

function diveScratchTemplateSegments(): string[] {
	return diveScratchTemplate().slice(0, -1).split("/");
}

function diveScratchWorkspaceSegments(diveId: string): string[] {
	return diveScratchTemplateSegments()
		.slice(1)
		.map((segment) => (segment === DIVE_ID_PLACEHOLDER ? diveId : segment));
}

export function diveScratchDisplayPath(
	bridgeDir: string,
	workspaceDir: string,
	diveId: string,
): string {
	return `${relative(bridgeDir, diveScratchPath(workspaceDir, diveId)).replaceAll("\\", "/")}/`;
}

export function renderDiveScratchHandoff(
	bridgeDir: string,
	workspaceDir: string,
	diveId: string,
): string {
	return (
		`Scratch space for this dive: ${diveScratchDisplayPath(bridgeDir, workspaceDir, diveId)} ` +
		`Write temp files there, never /tmp. It is local only; pack will not capture it.`
	);
}

export function diveScratchPath(workspaceDir: string, diveId: string): string {
	return join(workspaceDir, ...diveScratchWorkspaceSegments(diveId));
}

export function diveScratchRootPath(workspaceDir: string): string {
	return join(workspaceDir, ...diveScratchTemplateSegments().slice(1, -1));
}

export function recreateDiveScratch(workspaceDir: string, diveId: string): string {
	const path = diveScratchPath(workspaceDir, diveId);
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
	return path;
}

export function removeDiveScratch(workspaceDir: string, diveId: string): void {
	rmSync(diveScratchPath(workspaceDir, diveId), { recursive: true, force: true });
}
