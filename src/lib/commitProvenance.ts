import { nosedivePackageVersion } from "./packageBacklog.js";

/** Formats commits authored by nosedive with machine-readable provenance. */
export function commitMessage(subject: string, effortId?: string): string {
	const trailers = effortId ? [`Effort: ${effortId}`] : [];
	trailers.push(`Co-Authored-By: nosedive ${nosedivePackageVersion()} <noreply@nosedive.dev>`);
	// One block, single-spaced: git only parses the last paragraph as trailers, so
	// a blank line between them would leave `Effort:` invisible to
	// `git interpret-trailers`.
	return `${subject}\n\n${trailers.join("\n")}`;
}

export interface CommitProvenanceOptions {
	effort: boolean;
	coAuthor: boolean;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Generates the worktree hook that gives implementation commits provenance. */
export function prepareCommitMsgHook(
	effortId: string,
	originalHookPath: string | undefined,
	options: CommitProvenanceOptions,
): string {
	const trailers = options.effort ? [`Effort: ${effortId}`] : [];
	if (options.coAuthor) {
		trailers.push(`Co-Authored-By: nosedive ${nosedivePackageVersion()} <noreply@nosedive.dev>`);
	}
	return [
		"#!/bin/sh",
		"# nosedive-managed prepare-commit-msg",
		...(originalHookPath
			? [
					`original_hook=${shellQuote(originalHookPath)}`,
					'if [ -x "$original_hook" ]; then',
					'  "$original_hook" "$@" || exit $?',
					"fi",
				]
			: []),
		...trailers.flatMap((trailer) => [
			`if ! grep -Fqx -- ${shellQuote(trailer)} "$1"; then`,
			`  git interpret-trailers --in-place --trailer ${shellQuote(trailer)} "$1" || exit 1`,
			"fi",
		]),
		"",
	].join("\n");
}
