/**
 * Processor for `dump-backlog@1`. The bridge's configured `backlog:` value is
 * a KB memo id at L1, so the typechecked host renders that memo body.
 */
export async function run(value, ctx) {
	return ctx.invoke("dump-backlog.memo", value.args);
}
