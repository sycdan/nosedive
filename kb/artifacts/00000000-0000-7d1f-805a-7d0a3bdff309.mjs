export async function postCrud(value, ctx) {
	if (value.action !== "create") return { stdout: "", stderr: "", exitCode: 0 };
	return ctx.impl.i81a1fb568d0d5eb0a33a0313a736bcb7(["--root", value.root, "--id", value.doc.id]);
}
