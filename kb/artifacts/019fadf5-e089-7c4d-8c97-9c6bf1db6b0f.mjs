/** @see [../af12dc22-6bad-5e2a-aca9-ff0163dd39dd.md](../af12dc22-6bad-5e2a-aca9-ff0163dd39dd.md) */
export async function handle(value, ctx) {
	return ctx.impl.proof__proveAssertionL1(value.args);
}
