import type { SpecSource } from "@werft-ai/contracts";
import type { InstalledRuntimes } from "../agents/release-run.ts";
import { releaseSpecRecord } from "../agents/release-spec.ts";
import type { WorkerBinding } from "../ports/worker-unit-of-work.ts";
import type {
  CatalogConnection,
  CatalogRepository,
  SessionCatalog,
} from "../sessions/catalog.ts";
import type { ToolCatalogs } from "../sessions/tool-names.ts";

export const TEST_CONNECTION_ID = "conn-1";

/** A connection as the services hold it, its credential resolved. */
export function testConnection(
  overrides: Partial<CatalogConnection> = {},
): CatalogConnection {
  return {
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: {
        kind: "api_key",
        value: "resolved-key",
        ref: { value_env: "PROVIDER_KEY" },
      },
    },
    models: ["claude-sonnet-5"],
    auto_mode: "unknown",
    ...overrides,
  };
}

/** A console App repository, as the settings resolve one. */
export function testRepository(
  name: string,
  branch = "main",
): CatalogRepository {
  return {
    url: `https://github.com/acme/${name}.git`,
    branch,
    auth: { kind: "github_app", registered: true },
  };
}

export const TEST_RUNTIME_VERSION = "0.3.270";

/** The runtimes this test image ships: the claude engine only. */
export const TEST_RUNTIMES: InstalledRuntimes = {
  claude_agent_sdk: TEST_RUNTIME_VERSION,
};

/** One built-in tool catalog, answered for every runtime and version. */
export function testToolCatalogs(
  tools: readonly string[] = ["Read", "Edit", "Bash"],
): ToolCatalogs {
  const catalog = {
    id: "test@1",
    runtimeKind: "claude_agent_sdk",
    sdkVersion: TEST_RUNTIME_VERSION,
    engineVersion: TEST_RUNTIME_VERSION,
    tools: tools.map((name) => ({ name, boundary: "local" as const })),
  };
  return { all: [catalog], for: () => catalog };
}

export type TestCatalog = SessionCatalog & { tool_catalogs: ToolCatalogs };

export function testCatalog(overrides: Partial<TestCatalog> = {}): TestCatalog {
  return {
    connections: { [TEST_CONNECTION_ID]: testConnection() },
    repositories: {},
    tool_catalogs: testToolCatalogs(),
    ...overrides,
  };
}

/** A spec source on the test connection. */
export function testSpecSource(overrides: Partial<SpecSource> = {}): SpecSource {
  return {
    derivation_version: 2,
    runtime: { kind: "claude_agent_sdk", version: TEST_RUNTIME_VERSION },
    connection: {
      id: TEST_CONNECTION_ID,
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      billing: "per_token",
    },
    model: "claude-sonnet-5",
    permission_mode: "default",
    tools: ["Read"],
    repository_mode: "optional",
    ...overrides,
  };
}

export const TEST_SESSION_ID = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

/**
 * A claimed session as the store binds it: attempt `att_1` on its own
 * verified spec, no repository, nothing spent.
 */
export function testBinding(
  overrides: Partial<WorkerBinding> = {},
): WorkerBinding {
  const spec = overrides.spec ?? testSpecSource();
  return {
    sessionId: TEST_SESSION_ID,
    attemptId: "att_1",
    leaseEpoch: 1,
    executionGeneration: 1,
    authRevision: 0,
    leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
    leaseRemainingMs: 29_950,
    spec,
    specDigest: releaseSpecRecord(spec).spec_digest,
    model: spec.model,
    unmetered: false,
    ownerScope: "owner-a",
    repository: null,
    restore: null,
    costUsd: 0,
    providerTokens: 0,
    grants: [],
    ...overrides,
  };
}
