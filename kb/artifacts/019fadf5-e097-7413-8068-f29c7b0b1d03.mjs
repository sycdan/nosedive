/** @see [../c4e93002-2925-58bd-9b70-d917017a9fc7.md](../c4e93002-2925-58bd-9b70-d917017a9fc7.md) */
export async function handle(value, ctx) {
	return ctx.impl.workspace__hydrateRepoL1(value.args);
}
