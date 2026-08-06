import { nosedivePackageVersion } from "./packageBacklog.js";

/** Formats commits authored by nosedive with machine-readable provenance. */
export function commitMessage(subject: string, effortId?: string): string {
	const trailers = effortId ? [`Effort: ${effortId}`] : [];
	trailers.push(`Co-Authored-By: nosedive ${nosedivePackageVersion()} <noreply@nosedive.dev>`);
	return `${subject}\n\n${trailers.join("\n\n")}`;
}
