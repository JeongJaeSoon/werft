import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  MAX_RESTORE_CONFIGS,
  type RuntimeConfig,
} from "@werft-ai/contracts";
import {
  mcpBinding,
  type SessionWorkspaceMcp,
  WERFT_MCP_ENDPOINT,
  werftMcpBinding,
  workspaceMcpBinding,
} from "../catalog/catalog.ts";
import type {
  ClaimInput,
  ClaimResult,
  EgressIssue,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { WorkerPendingStore } from "../sessions/ports/pending-requests.ts";
import { testBinding, testCatalog } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import { storableLegacyConfig } from "./legacy-runtime-configs.ts";
import type { McpEgressStore } from "./ports/mcp-egress.ts";
import type {
  WorkspaceMcpEgressStore,
  WorkspaceMcpSessionState,
} from "./ports/workspace-mcp-egress.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const DOCS_ID = "6f9a2d4e-1b3c-4d5e-8f70-123456789abc";
const catalogServer = {
  url: "https://catalog.example.test/mcp",
  credential_ref: "mcp/fake",
  auth: {
    kind: "bearer" as const,
    value: "example-catalog-value",
    ref: { stored: "mcp:fake" },
  },
  workspaces: ["default"],
};
const catalog = testCatalog({ mcp_servers: { fake: catalogServer } });

const docs: SessionWorkspaceMcp = {
  releaseId: "rel-1",
  serverId: DOCS_ID,
  name: "docs",
  url: "https://docs.example.test/mcp",
  tools: ["mcp__docs__search"],
};
const binding = testBinding({
  sessionId: SESSION,
  attemptId: "att_1",
  costUsd: 0,
  providerTokens: 0,
  repository: null,
  leaseEpoch: 1,
  executionGeneration: 1,
  authRevision: 0,
  leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
  leaseRemainingMs: 29_950,
  unmetered: false,
  ownerScope: "owner-a",
  restore: null,
  grants: [],
  workspaceMcp: [docs],
  githubMcp: { releaseId: "rel-1", tools: ["mcp__github__request_push"] },
});

function gatewayWith(
  work: Record<string, unknown>,
  extra: Partial<Parameters<typeof createWorkerGateway>[0]> = {},
) {
  const proxied = new Proxy(work, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      return () => {
        throw new Error(`not reached: ${String(key)}`);
      };
    },
  }) as unknown as WorkerUnitOfWork;
  return createWorkerGateway({
    work: proxied,
    catalog,
    pending: {} as unknown as WorkerPendingStore,
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 30_000,
    },
    ...extra,
  });
}

function claimWith(
  result: ClaimResult,
  capabilities?: { workspace_mcp: true },
): { claim: Promise<unknown>; asked: ClaimInput[] } {
  const asked: ClaimInput[] = [];
  const gateway = gatewayWith({
    claimAtomic: async (input: ClaimInput) => {
      asked.push(input);
      return result;
    },
  });
  const claim = gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      ...(capabilities === undefined ? {} : { capabilities }),
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
    },
  );
  return { claim, asked };
}

type Claimed = {
  runtime_config: {
    tools: string[];
    mcp_servers?: Array<{ name: string; endpoint: string; binding: string }>;
  };
  restore_runtime_configs?: Array<{
    tools: string[];
    mcp_servers?: Array<{ name: string; binding: string }>;
  }>;
};

const bindingsInput = (
  overrides: Partial<Parameters<EgressIssue["bindingsOf"]>[0]>,
): Parameters<EgressIssue["bindingsOf"]>[0] => ({
  id: SESSION,
  connectionId: Object.keys(catalog.connections)[0] as string,
  specDigest: "sha256:spec",
  model: "m",
  repositoryMode: "none",
  repositoryId: null,
  githubPolicySource: "release",
  ...overrides,
});

describe("workspace MCP servers in the claim", () => {
  test("a worker that announced workspace_mcp gets workspace, then github, then werft entries", async () => {
    const { claim, asked } = claimWith(
      { outcome: "claimed", binding },
      { workspace_mcp: true },
    );
    const response = (await claim) as Claimed;
    expect(asked[0]?.workspaceMcp).toBe(true);
    expect(
      response.runtime_config.mcp_servers?.map((server) => [
        server.name,
        server.endpoint,
        server.binding,
      ]),
    ).toEqual([
      ["docs", docs.url, workspaceMcpBinding(docs)],
      ["github", expect.any(String), expect.any(String)],
      ["werft", WERFT_MCP_ENDPOINT, werftMcpBinding()],
    ]);
    expect(response.runtime_config.tools).toContain("mcp__docs__search");
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  test("a session without workspace servers claims as before, for either kind of worker", async () => {
    for (const capabilities of [undefined, { workspace_mcp: true as const }]) {
      const { claim } = claimWith(
        { outcome: "claimed", binding: { ...binding, workspaceMcp: [] } },
        capabilities,
      );
      const response = (await claim) as Claimed;
      expect(
        response.runtime_config.mcp_servers?.map((server) => server.name),
      ).toEqual(["github", "werft"]);
      // The config before `werft`, then the one before `github`: none that
      // only leaves workspace servers out.
      expect(
        response.restore_runtime_configs?.map((config) =>
          config.mcp_servers?.map((server) => server.name),
        ),
      ).toEqual([["github"], undefined]);
    }
  });

  test("a worker that did not announce workspace_mcp is told to wait: 503, retryable", async () => {
    const { claim, asked } = claimWith({
      outcome: "workspace_mcp_unsupported",
    });
    await expect(claim).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    expect(asked[0]?.workspaceMcp).toBeUndefined();
  });

  test("a resumed session is offered its config without the workspace servers, for checkpoints of a control-host that did not claim them", async () => {
    const { claim } = claimWith(
      {
        outcome: "claimed",
        binding: {
          ...binding,
          restore: {
            revision: 1,
            manifest_ref: "m",
            manifest_sha256: "0".repeat(64),
          },
        },
      },
      { workspace_mcp: true },
    );
    const response = (await claim) as Claimed;
    expect(
      response.restore_runtime_configs?.map((config) =>
        config.mcp_servers?.map((server) => server.name),
      ),
    ).toContainEqual(["github"]);
  });

  const retired = {
    releaseId: "rel-1",
    server: "fake",
    url: catalogServer.url,
    credentialRef: catalogServer.credential_ref,
    tools: ["mcp__fake__whoami"],
    restorable: true,
  };
  const restore = {
    revision: 1,
    manifest_ref: "m",
    manifest_sha256: "0".repeat(64),
  };

  test("a session a claim gave the retired catalog server claims without it, and is offered that claim's config after the one it ran before werft", async () => {
    const { claim } = claimWith(
      {
        outcome: "claimed",
        binding: {
          ...binding,
          retiredMcp: retired,
          restore: {
            revision: 1,
            manifest_ref: "m",
            manifest_sha256: "0".repeat(64),
          },
        },
      },
      { workspace_mcp: true },
    );
    const response = (await claim) as Claimed;
    expect(
      response.runtime_config.mcp_servers?.map((server) => server.name),
    ).toEqual(["docs", "github", "werft"]);
    expect(response.runtime_config.tools).not.toContain("mcp__fake__whoami");
    const [beforeWerft, first] = response.restore_runtime_configs ?? [];
    expect(beforeWerft?.mcp_servers?.map((server) => server.name)).toEqual([
      "docs",
      "github",
    ]);
    expect(
      first?.mcp_servers?.map((server) => [server.name, server.binding]),
    ).toEqual([
      ["fake", mcpBinding("rel-1", "fake", catalogServer)],
      ["docs", workspaceMcpBinding(docs)],
      ["github", expect.any(String)],
    ]);
    expect(first?.tools).toContain("mcp__fake__whoami");
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  test("a session created after the retire is not offered the retired server, even beside a workspace server of its name", async () => {
    const { claim } = claimWith(
      {
        outcome: "claimed",
        binding: {
          ...binding,
          workspaceMcp: [{ ...docs, name: "fake" }],
          retiredMcp: { ...retired, restorable: false },
          restore,
        },
      },
      { workspace_mcp: true },
    );
    const response = (await claim) as Claimed;
    const retiredBinding = mcpBinding("rel-1", "fake", catalogServer);
    for (const config of response.restore_runtime_configs ?? []) {
      const names = (config.mcp_servers ?? []).map((server) => server.name);
      expect(new Set(names).size).toBe(names.length);
      expect(
        (config.mcp_servers ?? []).map((server) => server.binding),
      ).not.toContain(retiredBinding);
    }
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  describe("the retired server's configs under the restore cap", () => {
    // One server, no workspace or github one: each kept config offers one
    // config with the retired server, so the counts are the kept configs.
    // The config the session ran before `werft` takes the first slot.
    const bare = { ...binding, workspaceMcp: [], githubMcp: null };
    type Served = {
      runtime_config: RuntimeConfig;
      restore_runtime_configs?: RuntimeConfig[];
    };
    const keptOf = async (models: string[]) => {
      const live = (
        (await claimWith({ outcome: "claimed", binding: bare }).claim) as Served
      ).runtime_config;
      return models.map((model) => storableLegacyConfig({ ...live, model }));
    };
    const claimKept = async (kept: RuntimeConfig[]) => {
      const dropped: Array<{ sessionId: string; dropped: number }> = [];
      const gateway = gatewayWith(
        {
          claimAtomic: async () => ({
            outcome: "claimed",
            binding: {
              ...bare,
              retiredMcp: retired,
              restore,
              legacyRuntimeConfigs: kept,
            },
          }),
        },
        { onRestoreConfigsDropped: (finding) => dropped.push(finding) },
      );
      const response = (await gateway.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: "e",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce: "n" },
        },
      )) as Served;
      const retiredModels = (response.restore_runtime_configs ?? [])
        .filter((config) =>
          (config.mcp_servers ?? []).some((server) => server.name === "fake"),
        )
        .map((config) => config.model);
      return { response, dropped, retiredModels };
    };
    const models = (count: number) =>
      Array.from({ length: count }, (_, at) => `sonnet-4-${at}`);

    test("fifteen of them are all offered, the claim's running one first, and nothing is reported", async () => {
      const { response, dropped, retiredModels } = await claimKept(
        await keptOf(models(14)),
      );
      expect(response.restore_runtime_configs).toHaveLength(
        MAX_RESTORE_CONFIGS,
      );
      expect(
        response.restore_runtime_configs?.[0]?.mcp_servers,
      ).toBeUndefined();
      expect(retiredModels).toEqual([
        response.runtime_config.model,
        ...models(14),
      ]);
      expect(dropped).toEqual([]);
    });

    test("ones the same once kept twice count once, and fit", async () => {
      const kept = await keptOf([...models(8), ...models(8)]);
      const { dropped, retiredModels } = await claimKept(kept);
      expect(retiredModels).toHaveLength(9);
      expect(new Set(retiredModels).size).toBe(9);
      expect(dropped).toEqual([]);
    });

    test("sixteen lose the oldest one, and the drop is reported with the session and the count", async () => {
      const { response, dropped, retiredModels } = await claimKept(
        await keptOf(models(15)),
      );
      expect(response.restore_runtime_configs).toHaveLength(
        MAX_RESTORE_CONFIGS,
      );
      expect(retiredModels).toEqual([
        response.runtime_config.model,
        ...models(14),
      ]);
      expect(dropped).toEqual([{ sessionId: SESSION, dropped: 1 }]);
    });
  });

  test("the egress token is held to the first workspace server", async () => {
    const { claim, asked } = claimWith(
      { outcome: "claimed", binding },
      { workspace_mcp: true },
    );
    await claim;
    const bindingsOf = asked[0]?.egress.bindingsOf;
    if (bindingsOf === undefined) throw new Error("no egress issue");
    expect(bindingsOf(bindingsInput({ workspaceMcp: [docs] })).mcp).toBe(
      workspaceMcpBinding(docs),
    );
  });

  test("a workspace server named github refuses the claim inside its transaction", async () => {
    const { claim, asked } = claimWith(
      { outcome: "claimed", binding },
      { workspace_mcp: true },
    );
    await claim;
    const bindingsOf = asked[0]?.egress.bindingsOf;
    if (bindingsOf === undefined) throw new Error("no egress issue");
    expect(() =>
      bindingsOf(
        bindingsInput({
          workspaceMcp: [{ ...docs, name: "github" }],
          githubMcp: { releaseId: "rel-1", tools: [] },
        }),
      ),
    ).toThrow(expect.objectContaining({ status: 503, retryable: true }));
  });
});

describe("the MCP egress route of a workspace server", () => {
  const authorized = {
    outcome: "ok",
    sessionId: SESSION,
    attemptId: "att_1",
    binding: mcpBinding("rel-1", "fake", catalogServer),
  };
  const state: WorkspaceMcpSessionState = {
    ownerId: "owner-a",
    workspaceId: "ws-1",
    agentId: "agent-1",
    releaseId: "rel-1",
    serverId: DOCS_ID,
    available: true,
    url: docs.url,
    connection: { state: "active", generation: 1 },
    tools: ["mcp__docs__search"],
    turnId: null,
    actor: null,
  };

  function routed() {
    const catalogAsked: string[] = [];
    const workspaceAsked: string[] = [];
    const workspaceStore: WorkspaceMcpEgressStore = {
      async sessionState(input) {
        workspaceAsked.push(input.server);
        return input.server === "docs" ? state : null;
      },
      async recordRefusal() {},
      async recordCall() {
        return true;
      },
    };
    const catalogStore: McpEgressStore = {
      async sessionState() {
        catalogAsked.push("fake");
        return {
          ownerId: "owner-a",
          workspaceSlug: "default",
          agentId: "agent-1",
          releaseId: "rel-1",
          server: "fake",
          tools: ["mcp__fake__whoami"],
          boundRefs: ["mcp/fake"],
          turnId: null,
          actor: null,
        };
      },
      async recordRefusal() {},
    };
    const gateway = gatewayWith(
      { authorizeEgressAtomic: async () => authorized },
      {
        mcp: catalogStore,
        workspaceMcp: {
          store: workspaceStore,
          credentialFor: async () => ({
            kind: "bearer",
            token: "example-workspace-value",
          }),
        },
      },
    );
    return { gateway, catalogAsked, workspaceAsked };
  }

  const ask = (server: string, tool: string) => ({
    token: "egress-token",
    server,
    rpc: { method: "tools/call", tool },
    regrant: false,
  });

  test("a workspace server's call goes upstream with the workspace credential, not the catalog's", async () => {
    const { gateway, catalogAsked } = routed();
    const grant = await gateway.authorizeMcpEgress(ask("docs", "search"));
    expect(grant.upstream).toEqual({
      url: docs.url,
      target: "/mcp",
      headers: [["authorization", "Bearer example-workspace-value"]],
    });
    expect(catalogAsked).toEqual([]);
  });

  test("a catalog server's call still takes the catalog's decision", async () => {
    const { gateway, catalogAsked, workspaceAsked } = routed();
    const grant = await gateway.authorizeMcpEgress(ask("fake", "whoami"));
    expect(grant.upstream.url).toBe(catalogServer.url);
    expect(workspaceAsked).toEqual(["fake"]);
    expect(catalogAsked).toEqual(["fake"]);
  });

  test("github never reads the workspace snapshot", async () => {
    const { gateway, workspaceAsked } = routed();
    await gateway
      .authorizeMcpEgress(ask("github", "request_push"))
      .catch(() => undefined);
    expect(workspaceAsked).toEqual([]);
  });
});
