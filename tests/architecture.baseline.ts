/**
 * Baselines and no-move lists for the dependency-direction rules in
 * tests/architecture.test.ts (docs/contributing/decisions/package-structure.md
 * section 5 and surface-action-modules.md section 8).
 *
 * Each baseline is today's violations, written down as they are. It only
 * shrinks: a PR that removes a violation deletes (or lowers) its entry, and a
 * violation missing from the list fails the test. Nothing is ever added.
 * A move PR that only changes a path rewrites the key; it does not add one.
 *
 * Keys are paths under packages/platform/src with "/" separators. A pair is
 * "<importing file> -> <imported file>". A count is the number of occurrences
 * in the file.
 */
export type Baseline = {
  /** A2: (file, target) pairs where a domain imports another domain's internals. */
  crossDomainImports: readonly string[];
  /** A4: contracts classes, async functions and handler-named exports, per "<file> <kind>". */
  contractsBehaviour: Readonly<Record<string, number>>;
  /** R4: platform surface/ <-> action/ imports, as pairs. */
  surfaceActionImports: readonly string[];
  /** R7: `fetch` references (call, typeof, default) per platform file. */
  directFetch: Readonly<Record<string, number>>;
  /** R8: platform files whose path has a "slack" segment. */
  slackFiles: readonly string[];
  /** R8: exported names containing "slack" per platform file. */
  slackExports: Readonly<Record<string, number>>;
};

export const baseline: Baseline = {
  crossDomainImports: [
    "action/change-request/pull-request-service.ts -> musterrolle/policy.ts",
    "action/change-request/push-executor.ts -> checkpoints/checkpoint-service.ts",
    "action/change-request/push-request-service.ts -> checkpoints/checkpoint-service.ts",
    "action/change-request/push-request-service.ts -> decision/push-approvability.ts",
    "action/change-request/push-request-service.ts -> musterrolle/policy.ts",
    "action/github/github-work-service.ts -> musterrolle/policy.ts",
    "action/tools/session-bound.ts -> musterrolle/policy.ts",
    "agents/agent-github-service.ts -> musterrolle/github-repository-service.ts",
    "agents/agent-github-service.ts -> musterrolle/policy.ts",
    "agents/agent-github-service.ts -> musterrolle/service-errors.ts",
    "agents/agent-github-service.ts -> sessions/catalog.ts",
    "agents/agent-github-service.ts -> sessions/github-connection-resolver.ts",
    "agents/agent-github-service.ts -> sessions/session-service.ts",
    "agents/agent-mcp-service.ts -> musterrolle/policy.ts",
    "agents/agent-mcp-service.ts -> musterrolle/service-errors.ts",
    "agents/agent-mcp-service.ts -> sessions/catalog.ts",
    "agents/agent-mcp-service.ts -> sessions/session-service.ts",
    "agents/agent-pull-request-service.ts -> musterrolle/policy.ts",
    "agents/agent-pull-request-service.ts -> musterrolle/service-errors.ts",
    "agents/agent-pull-request-service.ts -> action/change-request/pull-request-template.ts",
    "agents/agent-pull-request-service.ts -> sessions/session-service.ts",
    "agents/agent-service.ts -> extensions/resolve.ts",
    "agents/agent-service.ts -> extensions/session-extensions.ts",
    "agents/agent-service.ts -> musterrolle/policy.ts",
    "agents/agent-service.ts -> musterrolle/service-errors.ts",
    "agents/agent-service.ts -> sessions/catalog.ts",
    "agents/agent-service.ts -> sessions/profile-execution-form.ts",
    "agents/agent-service.ts -> sessions/session-service.ts",
    "agents/engine-settings-service.ts -> musterrolle/policy.ts",
    "agents/engine-settings-service.ts -> musterrolle/service-errors.ts",
    "agents/engine-settings-service.ts -> sessions/session-service.ts",
    "agents/mcp-release-values.ts -> sessions/catalog.ts",
    "agents/model-move-runner.ts -> sessions/catalog.ts",
    "agents/profile-rollout-runner.ts -> sessions/profile-rollout-policy.ts",
    "agents/release-ids.ts -> sessions/catalog.ts",
    "agents/release-spec.ts -> sessions/catalog.ts",
    "agents/tool-unlock.ts -> sessions/catalog.ts",
    "decision/pending-service.ts -> musterrolle/policy.ts",
    "extensions/bundle-service.ts -> musterrolle/policy.ts",
    "musterrolle/agent-admin-service.ts -> sessions/session-service.ts",
    "musterrolle/agent-identity-service.ts -> sessions/session-service.ts",
    "musterrolle/api-key-service.ts -> sessions/session-service.ts",
    "musterrolle/credential-binding-service.ts -> sessions/session-service.ts",
    "musterrolle/env-variable-service.ts -> sessions/session-service.ts",
    "musterrolle/github-app-service.ts -> sessions/session-service.ts",
    "musterrolle/github-packages-service.ts -> sessions/session-service.ts",
    "musterrolle/github-repository-service.ts -> sessions/session-service.ts",
    "musterrolle/github-settings-service.ts -> action/change-request/pull-request-template.ts",
    "musterrolle/github-settings-service.ts -> sessions/session-service.ts",
    "musterrolle/invite-service.ts -> sessions/session-service.ts",
    "musterrolle/linked-account-service.ts -> sessions/session-service.ts",
    "musterrolle/member-service.ts -> sessions/session-service.ts",
    "musterrolle/service-errors.ts -> sessions/session-service.ts",
    "musterrolle/session-share-service.ts -> sessions/session-service.ts",
    "musterrolle/surface-binding-service.ts -> sessions/session-service.ts",
    "musterrolle/team-service.ts -> sessions/session-service.ts",
    "scheduler/worker-images.ts -> sessions/catalog.ts",
    "sessions/achievements/achievement-rules.ts -> musterrolle/policy.ts",
    "sessions/achievements/achievement-rules.ts -> musterrolle/service-errors.ts",
    "sessions/achievements/session-achievement-service.ts -> musterrolle/policy.ts",
    "sessions/achievements/session-achievement-service.ts -> musterrolle/service-errors.ts",
    "sessions/git-attribution.ts -> musterrolle/policy.ts",
    "sessions/installation-profiles.ts -> musterrolle/policy.ts",
    "sessions/installation-profiles.ts -> musterrolle/service-errors.ts",
    "sessions/interrupt-service.ts -> musterrolle/policy.ts",
    "sessions/interrupt-service.ts -> scheduler/session-scheduler.ts",
    "sessions/output-service.ts -> checkpoints/checkpoint-service.ts",
    "sessions/output-service.ts -> musterrolle/policy.ts",
    "sessions/session-outcome-service.ts -> musterrolle/policy.ts",
    "sessions/session-service.ts -> agents/release-ids.ts",
    "sessions/session-service.ts -> extensions/resolve.ts",
    "sessions/session-service.ts -> extensions/session-extensions.ts",
    "sessions/session-service.ts -> limits/installation-limits.ts",
    "sessions/session-service.ts -> musterrolle/policy.ts",
    "sessions/settings-console-service.ts -> musterrolle/policy.ts",
    "sessions/settings-document-service.ts -> musterrolle/policy.ts",
    "sessions/workspace-profiles.ts -> musterrolle/policy.ts",
    "sessions/workspace-profiles.ts -> musterrolle/service-errors.ts",
    "usage/usage-service.ts -> limits/installation-limits.ts",
    "usage/usage-service.ts -> musterrolle/policy.ts",
    "usage/usage-service.ts -> sessions/session-service.ts",
    "workers/github-mcp-egress.ts -> action/github/github-mcp-server.ts",
    "workers/legacy-runtime-configs.ts -> sessions/catalog.ts",
    "workers/mcp-egress.ts -> sessions/catalog.ts",
    "workers/mcp-egress.ts -> sessions/mcp-tool-decision.ts",
    "workers/worker-gateway.ts -> checkpoints/checkpoint-service.ts",
    "workers/worker-gateway.ts -> checkpoints/checkpoint-support.ts",
    "workers/worker-gateway.ts -> checkpoints/durability.ts",
    "workers/worker-gateway.ts -> extensions/bundle-service.ts",
    "workers/worker-gateway.ts -> limits/installation-limits.ts",
    "workers/worker-gateway.ts -> limits/model-prices.ts",
    "workers/worker-gateway.ts -> sessions/achievements/achievement-judgment-store.ts",
    "workers/worker-gateway.ts -> sessions/achievements/judge-connections.ts",
    "workers/worker-gateway.ts -> sessions/achievements/judgment-token.ts",
    "workers/worker-gateway.ts -> sessions/catalog.ts",
    "workers/worker-gateway.ts -> sessions/event-codecs.ts",
    "workers/worker-gateway.ts -> sessions/git-attribution.ts",
    "workers/worker-gateway.ts -> sessions/github-connection-resolver.ts",
    "workers/worker-gateway.ts -> sessions/session-titler.ts",
  ],
  contractsBehaviour: {},
  surfaceActionImports: [],
  directFetch: {
    "musterrolle/github-packages-service.ts": 2,
    "sessions/achievements/decisions-client.ts": 2,
    "sessions/session-titler.ts": 2,
  },
  slackFiles: [
    "ports/slack-app-store.ts",
    "ports/slack-config-token-store.ts",
    "ports/slack-inbound-event-store.ts",
    "ports/slack-install-store.ts",
    "ports/slack-outbox-store.ts",
  ],
  slackExports: {
    "musterrolle/agent-identity-service.ts": 1,
    "musterrolle/policy.ts": 2,
    "ports/agent-identity-store.ts": 2,
    "ports/slack-app-store.ts": 7,
    "ports/slack-config-token-store.ts": 1,
    "ports/slack-inbound-event-store.ts": 4,
    "ports/slack-install-store.ts": 3,
    "ports/slack-outbox-store.ts": 25,
    "ports/workspace-settings.ts": 1,
  },
};

/**
 * Files that other things name by path, so a PR may edit them but not move or
 * delete them (package-structure.md section 3). A moved file breaks a package
 * `exports` subpath, the test preload, an image-prune keep list, a CLI the
 * deploy files run, or a test that asserts the path. Paths are from the
 * repository root. When a reference itself is updated in the same PR, update
 * this list in that PR too.
 */
export const pathFixed: readonly string[] = [
  // package.json `exports` subpaths of the packages the moves touch
  "packages/contracts/src/shared/agent-card.ts",
  "packages/contracts/src/shared/execution.ts",
  "packages/contracts/src/shared/settings.ts",
  "packages/db/src/migrate.ts",
  "packages/db/src/pool.ts",
  "packages/db/src/testing/checkpoints.ts",
  "packages/db/src/testing/fixture-team.ts",
  "packages/db/src/testing/launches.ts",
  "packages/platform/src/testing/agent-welcomable-contract.ts",
  "packages/platform/src/testing/approvable-contract.ts",
  "packages/platform/src/testing/channel-joinable-contract.ts",
  "packages/platform/src/testing/channel-kind-readable-contract.ts",
  "packages/platform/src/testing/checkpoints.ts",
  "packages/platform/src/testing/commentable-contract.ts",
  "packages/platform/src/testing/delivery-contract.ts",
  "packages/platform/src/testing/execution-backend-contract.ts",
  "packages/platform/src/testing/forge-contract-subject.ts",
  "packages/platform/src/testing/github-fakes.ts",
  "packages/platform/src/testing/notifiable-contract.ts",
  "packages/platform/src/testing/pull-request-mergeable-contract.ts",
  "packages/platform/src/testing/pull-request-readable-contract.ts",
  "packages/platform/src/testing/pull-request-writable-contract.ts",
  "packages/platform/src/testing/pushable-contract.ts",
  "packages/platform/src/testing/refusal.ts",
  "packages/platform/src/testing/repository-readable-contract.ts",
  "packages/platform/src/testing/reviewable-contract.ts",
  "packages/platform/src/testing/workflow-runnable-contract.ts",
  // bunfig.toml preload and scripts/image-prune.sh keep list
  "packages/db/src/pglite-release.ts",
  // tests/integration-jobs.test.ts asserts this exact path
  "packages/db/src/migrate.integration.test.ts",
  // entry points named by Dockerfile, compose, Helm, scripts and e2e commands
  "apps/control-host/src/main.ts",
  "apps/control-host/src/api/bootstrap-token-file.ts",
  "apps/control-host/src/api/checkpoint-gc.ts",
  "apps/control-host/src/api/demo-accounts.ts",
  "apps/control-host/src/api/demo-data.ts",
  "apps/control-host/src/api/forget-lost-checkpoints.ts",
  "apps/control-host/src/api/keys.ts",
  "apps/control-host/src/api/route-error-coverage.ts",
  "apps/control-host/src/api/session-archive.ts",
  "apps/control-host/src/api/settings.ts",
  "apps/control-host/src/api/upgrade-check.ts",
];

/**
 * Files the profile-removal series (JeongJaeSoon/werft#1488, #1489, #1490)
 * changed, kept out of every move until the series ends (package-structure.md
 * section 6.1). Taken from those PRs' changed-file lists, not from a name
 * pattern. Each move step refreshes it; S8 clears it once the series is done.
 */
export const profileSeriesFiles: readonly string[] = [
  "packages/adapters/runtimes/claude/src/engine-settings-claim.test.ts",
  "packages/contracts/src/api/receipt.ts",
  "packages/contracts/src/kollegium/engine-settings-storage.test.ts",
  "packages/contracts/src/kollegium/engine-settings-storage.ts",
  "packages/db/src/agent-engine-settings.test.ts",
  "packages/db/src/agent-engine-settings.ts",
  "packages/db/src/claim-engine-settings.test.ts",
  "packages/db/src/claim-engine-settings.ts",
  "packages/db/src/engine-settings-start.test.ts",
  "packages/db/src/engine-settings-start.ts",
  "packages/db/src/identity.integration.test.ts",
  "packages/db/src/mcp-egress.ts",
  "packages/db/src/postgres-unit-of-work.ts",
  "packages/db/src/schema.test.ts",
  "packages/db/src/schema.ts",
  "packages/db/src/worker-unit-of-work.ts",
  "packages/db/src/workspace-engine-settings.test.ts",
  "packages/db/src/workspace-engine-settings.ts",
  "packages/platform/src/ports/github-mcp.ts",
  "packages/platform/src/ports/worker-unit-of-work.ts",
  "packages/platform/src/sessions/engine-settings-merge.test.ts",
  "packages/platform/src/sessions/engine-settings-merge.ts",
  "packages/platform/src/sessions/engine-settings.test.ts",
  "packages/platform/src/sessions/engine-settings.ts",
  "packages/platform/src/action/github/github-mcp-server.test.ts",
  "packages/platform/src/action/github/github-mcp-server.ts",
  "packages/platform/src/workers/github-mcp-egress.test.ts",
  "packages/platform/src/workers/github-mcp-egress.ts",
  "packages/platform/src/workers/legacy-runtime-configs-engine-settings.test.ts",
  "packages/platform/src/workers/legacy-runtime-configs.ts",
  "packages/platform/src/workers/worker-gateway-engine-settings.test.ts",
  "packages/platform/src/workers/worker-gateway.ts",
];
