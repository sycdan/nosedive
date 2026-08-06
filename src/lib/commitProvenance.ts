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

/** Generates the worktree hook that gives implementation commits provenance. */
export function prepareCommitMsgHook(effortId: string): string {
	const trailers = [
		`Effort: ${effortId}`,
		`Co-Authored-By: nosedive ${nosedivePackageVersion()} <noreply@nosedive.dev>`,
	];
	return [
		"#!/bin/sh",
		"# nosedive-managed prepare-commit-msg",
		...trailers.flatMap((trailer) => [
			`if ! grep -Fqx -- '${trailer}' "$1"; then`,
			`  git interpret-trailers --in-place --trailer '${trailer}' "$1" || exit 1`,
			"fi",
		]),
		"",
	].join("\n");
}
