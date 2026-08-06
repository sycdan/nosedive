import { KbDoc } from "./kbDocs.js";
import { effortDocs } from "./repoEffortScopes.js";

export interface DropOptions {
	name: string;
}

export function parseDropArgs(args: string[]): DropOptions {
	let name: string | undefined;
	for (const arg of args) {
		if (arg.startsWith("--")) throw new Error(`unknown drop option: ${arg}`);
		if (name !== undefined) throw new Error(`unexpected drop argument: ${arg}`);
		name = arg;
	}
	const trimmed = (name ?? "").trim();
	if (!trimmed) throw new Error("drop requires a name");
	return { name: trimmed };
}

/**
 * A pilot types a drop's name the way they say it, not the way it is stored:
 * `nosedive drop "judgement day"` has to reach `judgement-day.release.nosedive`.
 * Slugging both sides is the whole of that translation.
 */
export function dropSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function leafSlug(effortName: string): string {
	return effortName.split(".")[0] ?? "";
}

export function resolveDropEffort(kbDocs: KbDoc[], name: string): KbDoc {
	const efforts = effortDocs(kbDocs);
	const byId = efforts.filter((doc) => doc.id === name);
	if (byId.length === 1) return byId[0]!;

	const byName = efforts.filter((doc) => doc.name === name);
	if (byName.length === 1) return byName[0]!;

	const slug = dropSlug(name);
	const bySlug = efforts.filter((doc) => leafSlug(doc.name) === slug || doc.name === slug);
	if (bySlug.length === 1) return bySlug[0]!;
	if (bySlug.length > 1) {
		// A slug is a leaf, so unrelated efforts share one readily. Only a dated
		// effort can be dropped at all, so an undated namesake is not a rival
		// candidate -- it is simply not in this election.
		const dated = bySlug.filter((doc) => (doc.metaScalars.target ?? "").trim() !== "");
		if (dated.length === 1) return dated[0]!;
		const names = (dated.length > 1 ? dated : bySlug).map((doc) => doc.name).sort();
		throw new Error(`drop name is ambiguous: ${name} (${names.join(", ")})`);
	}
	throw new Error(`drop not found: ${name}`);
}

/** A target is a calendar date, so it is compared as one -- no clock, no zone. */
export function dropTargetDate(effort: KbDoc): string {
	const target = (effort.metaScalars.target ?? "").trim();
	if (!target) {
		throw new Error(`drop ${effort.name} has no meta.target release date`);
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) {
		throw new Error(`drop ${effort.name} meta.target must be yyyy-mm-dd: ${target}`);
	}
	return target;
}

export function todayIsoDate(now = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function assertDropTargetReached(effort: KbDoc, target: string, today: string): void {
	if (today < target) {
		throw new Error(`${effort.name} drops on ${target}; today is ${today}`);
	}
}
