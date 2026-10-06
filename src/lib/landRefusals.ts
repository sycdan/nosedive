const refusalPrefix = "land refused because ";

/** The explicit expected value of a `--hard` push, plus what a refusal must name. */
export interface LandLease {
	repoId: string;
	pin: string;
	diveId: string;
	cli: string;
}

export function movedBranchRefusal(branch: string, published: string, scope: LandLease): string {
	const { cli, diveId, pin, repoId } = scope;
	return (
		`${refusalPrefix}scope ${repoId} cannot fast-forward ${branch}: its work branch on origin ` +
		`has moved past this dive's pin ${pin} to ${published}, and this dive's work does not contain it. ` +
		`Rebase the dive's work onto origin/${branch} and repin it:\n` +
		`  ${cli} pack\n` +
		`  ${cli} crud ${diveId} --repin ${branch} --scope ${repoId}\n` +
		`  ${cli} jump ${diveId}\n` +
		`then land again.`
	);
}

/** Shared by the pre-gate check and the push itself, so both refusals read alike. */
export function leaseRefusal(branch: string, lease: LandLease): string {
	return (
		`${refusalPrefix}scope ${lease.repoId} could not replace ${branch} under a lease expecting ` +
		`${lease.pin} -- the branch moved since this dive was pinned, or does not exist. ` +
		`Repin the dive at the new branch head (\`${lease.cli} crud ${lease.diveId} ` +
		`--repin ${branch} --scope ${lease.repoId}\`) and rebase again; do not force-push past it, which would discard whatever ` +
		`moved it`
	);
}
