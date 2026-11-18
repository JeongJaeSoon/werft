import { describe, expect, test } from "bun:test";
import { bootstrapClaimResponseSchema } from "@werft-ai/contracts";
import {
  mcpBinding,
  type SessionWorkspaceMcp,
  workspaceMcpBinding,
} from "../catalog/catalog.ts";
import type { McpEgressStore } from "../github/ports/mcp-egress.ts";
import type {
  ClaimInput,
  ClaimResult,
  EgressIssue,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type {
  WorkspaceMcpEgressStore,
  WorkspaceMcpSessionState,
} from "../ports/workspace-mcp-egress.ts";
import type { WorkerPendingStore } from "../sessions/ports/pending-requests.ts";
import { testBinding, testCatalog } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
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
  mcp: { releaseId: "rel-1", server: "fake", tools: ["mcp__fake__whoami"] },
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
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
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
    mcp_servers?: Array<{ name: string }>;
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
  test("a worker that announced workspace_mcp gets catalog, workspace, then github entries", async () => {
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
      ["fake", catalogServer.url, mcpBinding("rel-1", "fake", catalogServer)],
      ["docs", docs.url, workspaceMcpBinding(docs)],
      ["github", expect.any(String), expect.any(String)],
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
      ).toEqual(["fake", "github"]);
      expect(
        response.restore_runtime_configs?.map((config) =>
          config.mcp_servers?.map((server) => server.name),
        ),
      ).not.toContainEqual(["fake", "github"]);
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
    ).toContainEqual(["fake", "github"]);
  });

  test("the egress token is held to the catalog server first, else to the first workspace server", async () => {
    const { claim, asked } = claimWith(
      { outcome: "claimed", binding },
      { workspace_mcp: true },
    );
    await claim;
    const bindingsOf = asked[0]?.egress.bindingsOf;
    if (bindingsOf === undefined) throw new Error("no egress issue");
    const mcp = { releaseId: "rel-1", server: "fake", tools: [] };
    expect(bindingsOf(bindingsInput({ mcp, workspaceMcp: [docs] })).mcp).toBe(
      mcpBinding("rel-1", "fake", catalogServer),
    );
    expect(bindingsOf(bindingsInput({ workspaceMcp: [docs] })).mcp).toBe(
      workspaceMcpBinding(docs),
    );
  });

  test("a workspace server named as the catalog server or github refuses the claim inside its transaction", async () => {
    const { claim, asked } = claimWith(
      { outcome: "claimed", binding },
      { workspace_mcp: true },
    );
    await claim;
    const bindingsOf = asked[0]?.egress.bindingsOf;
    if (bindingsOf === undefined) throw new Error("no egress issue");
    const mcp = { releaseId: "rel-1", server: "fake", tools: [] };
    for (const input of [
      bindingsInput({ mcp, workspaceMcp: [{ ...docs, name: "fake" }] }),
      bindingsInput({
        workspaceMcp: [{ ...docs, name: "github" }],
        githubMcp: { releaseId: "rel-1", tools: [] },
      }),
    ]) {
      expect(() => bindingsOf(input)).toThrow(
        expect.objectContaining({ status: 503, retryable: true }),
      );
    }
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
