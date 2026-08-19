import { shellQuote } from "./constants.js";
import { nosedivePackageVersion } from "./packageBacklog.js";

/** Formats commits authored by nosedive with machine-readable provenance. */
export function commitMessage(subject: string, featId?: string): string {
	const trailers = featId ? [`Feat: ${featId}`] : [];
	trailers.push(`Co-Authored-By: nosedive ${nosedivePackageVersion()} <noreply@nosedive.dev>`);
	// One block, single-spaced: git only parses the last paragraph as trailers, so
	// a blank line between them would leave `Feat:` invisible to
	// `git interpret-trailers`.
	return `${subject}\n\n${trailers.join("\n")}`;
}

export interface CommitProvenanceOptions {
	/**
	 * Mirrors the `commit-provenance.feat` repo config key, whose older spelling
	 * `commit-provenance.effort` is still read.
	 */
	feat: boolean;
	coAuthor: boolean;
}

export const GIT_HOOK_NAMES = [
	"applypatch-msg",
	"commit-msg",
	"fsmonitor-watchman",
	"post-applypatch",
	"post-checkout",
	"post-commit",
	"post-merge",
	"post-receive",
	"post-rewrite",
	"post-update",
	"pre-applypatch",
	"pre-auto-gc",
	"pre-commit",
	"pre-merge-commit",
	"pre-push",
	"pre-rebase",
	"pre-receive",
	"prepare-commit-msg",
	"proc-receive",
	"push-to-checkout",
	"reference-transaction",
	"sendemail-validate",
	"update",
] as const;

export function proxyHook(originalHookPath: string): string {
	return `#!/bin/sh\nexec ${shellQuote(originalHookPath)} "$@"\n`;
}

/** Generates the worktree hook that gives implementation commits provenance. */
export function prepareCommitMsgHook(
	featId: string,
	diveId: string,
	originalHookPath: string | undefined,
	options: CommitProvenanceOptions,
): string {
	const trailers = [`Dive: ${diveId}`];
	if (options.feat) trailers.push(`Feat: ${featId}`);
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
