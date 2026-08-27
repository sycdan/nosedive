export interface CommandHelpTextInput {
	usage: string;
	gist: string;
	id: string;
}

export function renderCommandHelpText(command: CommandHelpTextInput): string;
