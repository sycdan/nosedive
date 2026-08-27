/**
 * Render the compact help shared by the CLI and the generated README command
 * surface. Keep this module plain ESM so generation can use the source before
 * a package build has produced dist/.
 *
 * @param {{ usage: string, gist: string, id: string }} command
 * @returns {string}
 */
export function renderCommandHelpText(command) {
	const usage = command.usage.trim();
	const gist = command.gist.trim();
	const usageLine = usage ? `Usage: ${usage}` : "";
	const manualCommand = `More: nosedive render ${command.id}`;
	return [usageLine, gist, manualCommand].filter(Boolean).join("\n\n");
}
