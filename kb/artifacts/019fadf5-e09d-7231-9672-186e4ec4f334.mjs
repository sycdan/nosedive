/** @see [../3570e756-f8e7-5e95-b911-09d7d116cd23.md](../3570e756-f8e7-5e95-b911-09d7d116cd23.md) */
export async function handle(value, ctx) {
	return ctx.impl.bridge__nukeConfigL1(value.args);
}
