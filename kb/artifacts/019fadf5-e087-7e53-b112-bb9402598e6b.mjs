/**
 * Executor for the `preflight` contract. The command itself stays in the
 * typechecked nosedive source; this runs it with a capturing io and hands the
 * captured streams back to the contract host.
 */
export async function run(value, ctx) {
	return ctx.invoke("preflight", value.args);
}
