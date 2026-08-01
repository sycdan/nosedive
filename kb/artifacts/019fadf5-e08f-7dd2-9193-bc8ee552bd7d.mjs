/**
 * Processor for the `dump-backlog@0` command doc. The command itself stays in the
 * typechecked nosedive source; this runs it with a capturing io and hands the
 * captured streams back to the command doc host.
 */
export async function run(value, ctx) {
	return ctx.invoke("dump-backlog", value.args);
}
