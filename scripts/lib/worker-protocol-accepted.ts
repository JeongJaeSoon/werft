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
    problem: 'error $.error.code: the receiver refuses "NO_CAPACITY"',
    why: "No route answers it: the scheduler writes it onto the receipts of input that waited too long for room, which only receipt reads on API and console routes return; no worker route reads a receipt.",
    proof: "packages/db/src/scheduler/scheduler-store.test.ts",
  },
  {
    problem:
      'error $.error.code: the receiver refuses "CODEX_SANDBOX_NOT_INSTALLED"',
    why: "No route answers it: the scheduler writes it onto the receipts of input whose launch it refused before creating the worker, which only receipt reads on API and console routes return; no worker route reads a receipt.",
    proof: "packages/db/src/scheduler/scheduler-store.test.ts",
  },
];
