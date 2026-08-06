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
