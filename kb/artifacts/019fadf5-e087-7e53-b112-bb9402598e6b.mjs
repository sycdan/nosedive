/** @see [../d6e4bbe3-b158-5e6d-a734-e0ce77acfdce.md](../d6e4bbe3-b158-5e6d-a734-e0ce77acfdce.md) */
export async function handle(value, ctx) {
	return ctx.impl.bridge__preflightL1(value.args);
}
