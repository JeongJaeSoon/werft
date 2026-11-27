/**
 * Differences from the worker protocol baseline that do not break a worker of
 * that release, each with the test that shows why. `problem` is the
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
}[] = [
  {
    problem: 'error $.error.code: the receiver refuses "WORKER_OWNERSHIP_LOST"',
    why: "No route answers it: the exit's settle writes it onto the input receipt of a turn whose worker lost its lease, once that worker is gone, and only receipt reads on API and console routes return it; no worker route reads a receipt.",
    proof: "packages/db/src/worker-ownership-lost.test.ts",
  },
  {
    problem: 'error $.error.code: the receiver refuses "ENDPOINT_RETIRED"',
    why: "Only the two retired Slack notice routes answer it (POST /v1/agents/{id}/slack/notice/approve and /revoke, 410), public /v1 routes for people and their keys; no worker route answers it and a worker calls neither.",
    proof: "apps/control-host/src/api/routes/surface/slack-notice.test.ts",
  },
];
