/**
 * Executor for the `pre-push.hook` command doc. The command itself stays in the
 * typechecked nosedive source; this runs it with a capturing io and hands the
 * captured streams back to the command doc host.
 */
export async function run(value, ctx) {
	return ctx.invoke("pre-push.hook", value.args);
}
