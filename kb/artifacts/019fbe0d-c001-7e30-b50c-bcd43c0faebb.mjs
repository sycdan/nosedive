/** @see [../eb6305b4-9aa6-5fdb-b622-e0d17b6303bb.md](../eb6305b4-9aa6-5fdb-b622-e0d17b6303bb.md) */
export async function handle(value, ctx) {
	return ctx.impl.backlog__updateMemoL1(value.args);
}
