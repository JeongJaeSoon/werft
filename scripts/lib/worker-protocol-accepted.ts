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
    problem:
      "/bootstrap-claim response $.runtime_config.skip_web_fetch_preflight: the receiver refuses this key (additionalProperties: false)",
    why: "Sent only to a worker that announced web_fetch_preflight, which the baseline worker cannot; without it the claim carries no key and the check stays on.",
    proof:
      "packages/platform/src/workers/worker-gateway-response-language.test.ts",
  },
  {
    problem:
      "/bootstrap-claim response $.restore_runtime_configs[].skip_web_fetch_preflight: the receiver refuses this key (additionalProperties: false)",
    why: "The gateway adds the key to the claim's current runtime_config only, never to a restore config, and only for a worker that announced web_fetch_preflight.",
    proof:
      "packages/platform/src/workers/worker-gateway-response-language.test.ts",
  },
];
