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
}[] = [
  {
    problem:
      'error $.error.code: the receiver refuses "MCP_SERVER_QUOTA_EXCEEDED"',
    why: "Only POST /v1/workspace/mcp-servers answers it, a console-session route no worker calls; no worker route reaches the workspace MCP service.",
    proof:
      "apps/control-host/src/api/routes/musterrolle/workspace-mcp-servers.test.ts",
  },
  {
    problem:
      'error $.error.code: the receiver refuses "DECISION_MODEL_REQUIRED"',
    why: "Only the achievement rule, judge settings, rejudge and review routes answer it, console-session routes no worker calls; the worker's outcome writes only queue a judgment, which never refuses.",
    proof: "apps/control-host/src/api/routes/sessions/achievements.test.ts",
  },
  {
    problem:
      "/bootstrap-claim response $.runtime_config.mcp_servers: the receiver's maxItems is 2; the sender's is 10",
    why: "Only a worker that announced workspace_mcp gets workspace servers; a claim from a worker without it is refused, retryable, before anything is bound, so it still gets at most the catalog server and github.",
    proof: "packages/platform/src/workers/worker-gateway-workspace-mcp.test.ts",
  },
  {
    problem:
      "/bootstrap-claim response $.restore_runtime_configs[].mcp_servers: the receiver's maxItems is 2; the sender's is 10",
    why: "Restore configs are built from the same claimed entries as runtime_config, so a worker without workspace_mcp gets at most two there too.",
    proof: "packages/platform/src/workers/worker-gateway-workspace-mcp.test.ts",
  },
];
