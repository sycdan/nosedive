/** @see [../9c07d8f1-61d4-531c-a926-863ce61e4785.md](../9c07d8f1-61d4-531c-a926-863ce61e4785.md) */
export async function handle(value, ctx) {
	return ctx.impl.bridge__prePushHookL1(value.args);
}
