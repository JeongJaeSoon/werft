/**
 * Differences from the worker protocol baseline that do not break a worker of
 * that release, each with the test that shows why
 * (docs/contributing/decisions/worker-compat.md § 3.4). `problem` is the
 * contract test's line, word for word; `proof` is a repository path.
 *
 * Example: a field a control-host adds to a strict response object only for
 * workers that announce a capability the baseline worker cannot send, proved
 * by the gateway test that leaves it out without that capability.
 *
 * Refreshing the baseline turns entries stale; the contract test then fails
 * until they are removed.
 */
export const ACCEPTED: readonly {
  problem: string;
  why: string;
  proof: string;
}[] = [];
