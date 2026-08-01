/**
 * Processor for `update-backlog@1`. The typechecked host scans bridge KB
 * effort docs and rewrites the configured backlog memo.
 */
export async function run(value, ctx) {
	return ctx.invoke("update-backlog", value.args);
}
