/** @see [../32123800-a61d-5ea1-8b85-98c288b127b3.md](../32123800-a61d-5ea1-8b85-98c288b127b3.md) */
export async function handle(value, ctx) {
	return ctx.impl.workspace__dehydrateRepoL1(value.args);
}
