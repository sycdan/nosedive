export interface ImplCommandOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ImplRuntime {
	cwd: string;
}
