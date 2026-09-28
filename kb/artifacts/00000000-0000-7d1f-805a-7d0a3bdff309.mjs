export async function crud(value, ctx) {
	const name = value.name === undefined ? [] : ["--name", value.name];
	return ctx.impl.i81a1fb568d0d5eb0a33a0313a736bcb7(["--root", value.root, ...name, ...value.args]);
}
