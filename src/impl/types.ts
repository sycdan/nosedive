export interface ImplCommandOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ImplRuntime {
	cwd: string;
	/**
	 * The command doc this impl was reached through. An impl that reads its own
	 * contract -- an effort range, say -- must read the doc the router actually
	 * resolved, not one it re-derives and could disagree with.
	 */
	commandDoc?: {
		id?: string;
		name: string;
		path: string;
	};
}
