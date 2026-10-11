/**
 * The version of the core API nosedive-helm imports from this package (the
 * block so marked in `src/nosedive.ts`). `nosedive helm` hands it to helm as
 * NOSEDIVE_PROTOCOL; helm refuses to start on one it was not built for. Bump it
 * when that block changes incompatibly; adding to it is not a bump.
 */
export const HELM_PROTOCOL = 1;
