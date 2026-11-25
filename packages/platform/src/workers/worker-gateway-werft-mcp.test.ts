import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  type RuntimeKind,
  runtimeMcpServerSchema,
  WERFT_MCP_SERVER,
} from "@werft-ai/contracts";
import { verifyBuiltinMcpGrant } from "../action/github/github-mcp-server.ts";
import {
  type SessionWorkspaceMcp,
  WERFT_MCP_ENDPOINT,
  werftMcpBinding,
  workspaceMcpBinding,
} from "../catalog/catalog.ts";
import type {
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { WorkerPendingStore } from "../sessions/ports/pending-requests.ts";
import {
  testBinding,
  testCatalog,
  testSpecSource,
} from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import type { WorkspaceMcpEgressStore } from "./ports/workspace-mcp-egress.ts";
import { WERFT_MCP_UPSTREAM_PATH } from "./werft-mcp-egress.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const KEY = new Uint8Array(32).fill(7);
const CAPABLE = { platform_tool_trust: true, workspace_mcp: true } as const;

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
    catalog: testCatalog(),
    pending: {} as unknown as WorkerPendingStore,
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 30_000,
    },
    ...extra,
  });
}

async function claim(
  bound: Partial<WorkerBinding> = {},
  options: {
    capabilities?: Partial<typeof CAPABLE>;
    tools?: readonly string[];
  } = {},
) {
  const binding = testBinding({ sessionId: SESSION, ...bound });
  const gateway = gatewayWith(
    { claimAtomic: async () => ({ outcome: "claimed", binding }) },
    { werftMcp: { grantKey: KEY, tools: options.tools ?? [] } },
  );
  const response = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      capabilities: options.capabilities ?? CAPABLE,
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
    },
  );
  expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  return response;
}

const serversOf = (response: Awaited<ReturnType<typeof claim>>) =>
  response.runtime_config.mcp_servers ?? [];
const werftOf = (response: Awaited<ReturnType<typeof claim>>) =>
  serversOf(response).find((server) => server.name === WERFT_MCP_SERVER);

const docs: SessionWorkspaceMcp = {
  releaseId: "rel-1",
  serverId: "6f9a2d4e-1b3c-4d5e-8f70-123456789abc",
  name: "docs",
  url: "https://docs.example.test/mcp",
  tools: ["mcp__docs__search"],
};
const github = { releaseId: "rel-1", tools: ["mcp__github__request_push"] };

describe("the built-in werft server in the claim", () => {
  test("a session of either engine gets it, with the same entry", async () => {
    const kinds: RuntimeKind[] = ["claude_agent_sdk", "codex_app_server"];
    const entries = await Promise.all(
      kinds.map(async (kind) => {
        const spec = testSpecSource({
          runtime: { kind, version: "1.0.0" },
          tools: kind === "codex_app_server" ? ["exec_command"] : ["Read"],
        });
        const response = await claim({ spec });
        expect(response.runtime.kind).toBe(kind);
        const { access: _, ...entry } = werftOf(response) ?? {};
        return entry;
      }),
    );
    expect(entries).toEqual([
      {
        name: "werft",
        endpoint: WERFT_MCP_ENDPOINT,
        binding: werftMcpBinding(),
        platform: true,
      },
      {
        name: "werft",
        endpoint: WERFT_MCP_ENDPOINT,
        binding: werftMcpBinding(),
        platform: true,
      },
    ]);
  });

  test("it is the last entry, after the workspace servers and github", async () => {
    const response = await claim({ workspaceMcp: [docs], githubMcp: github });
    expect(serversOf(response).map((server) => server.name)).toEqual([
      "docs",
      "github",
      "werft",
    ]);
  });

  // The whole point of the test: the gateway reads nothing of the session
  // for this server, so nothing an agent, a release or a workspace sets can
  // take it out of a claim.
  test("no release, agent or workspace setting takes it out", async () => {
    const settings: Array<[string, Partial<WorkerBinding>]> = [
      ["no GitHub settings on the release", { githubMcp: null }],
      ["no workspace servers", { workspaceMcp: [] }],
      [
        "a caller limit that denies its whole server",
        { callerToolsDeny: ["mcp__werft__*", "mcp__werft__find", "Read"] },
      ],
      [
        "a spec with no tools the limit leaves",
        { spec: testSpecSource({ tools: [] }), callerToolsDeny: ["Read"] },
      ],
      ["a session without a repository", { repository: null }],
      [
        "a retired catalog server of its name",
        {
          retiredMcp: {
            releaseId: "rel-1",
            server: "werft",
            url: "https://mcp.example.invalid/werft",
            credentialRef: "werft",
            tools: ["mcp__werft__old"],
            restorable: true,
          },
        },
      ],
    ];
    for (const [what, bound] of settings) {
      const response = await claim(bound, { tools: ["find"] });
      expect([what, werftOf(response)]).toEqual([
        what,
        expect.objectContaining({
          name: "werft",
          binding: werftMcpBinding(),
          platform: true,
          trusted: ["mcp__werft__find"],
        }),
      ]);
    }
  });

  test("the tools it serves are trusted and in no tool list, so serving another moves neither the list nor the binding", async () => {
    const one = await claim({}, { tools: ["find"] });
    const two = await claim({}, { tools: ["find", "status"] });
    expect(werftOf(one)?.trusted).toEqual(["mcp__werft__find"]);
    expect(werftOf(two)?.trusted).toEqual([
      "mcp__werft__find",
      "mcp__werft__status",
    ]);
    // What a checkpoint fingerprint reads of an MCP server: the tool list
    // and the server's name and binding.
    for (const response of [one, two]) {
      expect(
        response.runtime_config.tools.filter((tool) =>
          tool.startsWith("mcp__werft__"),
        ),
      ).toEqual([]);
    }
    expect(two.runtime_config.tools).toEqual(one.runtime_config.tools);
    expect(werftOf(two)?.binding).toBe(werftOf(one)?.binding);
  });

  test("with nothing to serve yet it carries the platform mark alone", async () => {
    const entry = werftOf(await claim());
    expect(entry).toMatchObject({ platform: true });
    expect(Object.keys(entry ?? {})).not.toContain("trusted");
  });

  test("a worker that did not announce platform_tool_trust gets it with neither mark, and its old strict schema parses it", async () => {
    // The schema of a worker image from before `platform` and `trusted`.
    const oldServer = runtimeMcpServerSchema.omit({
      platform: true,
      trusted: true,
    });
    const entry = werftOf(
      await claim({}, { capabilities: {}, tools: ["find"] }),
    );
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {})).not.toContain("platform");
    expect(Object.keys(entry ?? {})).not.toContain("trusted");
    expect(oldServer.safeParse(entry).success).toBe(true);
  });

  test("a gateway with no key for its grants still names it, with nothing trusted", async () => {
    const binding = testBinding({ sessionId: SESSION });
    const gateway = gatewayWith({
      claimAtomic: async () => ({ outcome: "claimed", binding }),
    });
    const response = await gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        capabilities: CAPABLE,
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      },
    );
    expect(werftOf(response)).toMatchObject({ name: "werft", platform: true });
  });

  test("a workspace server registered as werft before the name was reserved is left out, and a checkpoint made with it still restores", async () => {
    const squatter = { ...docs, name: "werft", tools: ["mcp__werft__search"] };
    const response = await claim({ workspaceMcp: [squatter, docs] });
    expect(
      serversOf(response).map((server) => [server.name, server.binding]),
    ).toEqual([
      ["docs", workspaceMcpBinding(docs)],
      ["werft", werftMcpBinding()],
    ]);
    expect(response.runtime_config.tools).not.toContain("mcp__werft__search");
    // The config a claim gave before the built-in server: the workspace
    // server under its name, with its tools.
    const [before] = response.restore_runtime_configs ?? [];
    expect(
      before?.mcp_servers?.map((server) => [server.name, server.binding]),
    ).toEqual([
      ["werft", workspaceMcpBinding(squatter)],
      ["docs", workspaceMcpBinding(docs)],
    ]);
    expect(before?.tools).toContain("mcp__werft__search");
  });

  test("a session claimed before it existed is offered the config it ran then, first", async () => {
    const response = await claim({ workspaceMcp: [docs], githubMcp: github });
    const [before] = response.restore_runtime_configs ?? [];
    expect(before?.mcp_servers?.map((server) => server.name)).toEqual([
      "docs",
      "github",
    ]);
    const { mcp_servers: _now, ...current } = response.runtime_config;
    const { mcp_servers: _then, ...then } = before ?? {};
    expect(then).toEqual(current);
  });
});

describe("the built-in werft server's egress route", () => {
  const authorized = {
    outcome: "ok" as const,
    sessionId: SESSION,
    attemptId: "att_1",
    binding: werftMcpBinding(),
  };
  const ask = (method: string | null, tool: string | null = null) => ({
    token: "egress-token-of-the-attempt",
    server: WERFT_MCP_SERVER,
    rpc: { method, tool },
    regrant: false,
  });

  function routed(withKey = true) {
    const asked: string[] = [];
    // A workspace server squatting on the name must never be asked.
    const workspaceStore: WorkspaceMcpEgressStore = {
      async sessionState(input) {
        asked.push(input.server);
        return null;
      },
      async recordRefusal() {},
      async recordCall() {
        return true;
      },
    };
    const gateway = gatewayWith(
      { authorizeEgressAtomic: async () => authorized },
      {
        workspaceMcp: {
          store: workspaceStore,
          credentialFor: async () => null,
        },
        ...(withKey ? { werftMcp: { grantKey: KEY, tools: [] } } : {}),
      },
    );
    return { gateway, asked };
  }

  test("is granted on the token's fence alone, with a grant for that session and attempt", async () => {
    const { gateway, asked } = routed();
    const grant = await gateway.authorizeMcpEgress(ask("tools/call", "any"));
    expect(grant).toMatchObject({ session_id: SESSION, attempt_id: "att_1" });
    expect(grant.upstream.url).toBe(WERFT_MCP_UPSTREAM_PATH);
    const [[name, value] = []] = grant.upstream.headers ?? [];
    expect(name).toBe("authorization");
    expect(
      verifyBuiltinMcpGrant(
        KEY,
        (value ?? "").replace(/^Bearer /, ""),
        Date.now(),
      ),
    ).toEqual({ sessionId: SESSION, attemptId: "att_1" });
    // No workspace row, release or agent was read.
    expect(asked).toEqual([]);
  });

  test("routes every method the server answers, and a notification or a stream", async () => {
    const { gateway } = routed();
    for (const method of [
      "initialize",
      "ping",
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/templates/list",
      "resources/read",
      "prompts/list",
      "prompts/get",
      "notifications/initialized",
      null,
    ]) {
      const grant = await gateway.authorizeMcpEgress(ask(method));
      expect([method, grant.upstream.url]).toEqual([
        method,
        WERFT_MCP_UPSTREAM_PATH,
      ]);
    }
  });

  test("refuses a method the server does not answer", async () => {
    const { gateway } = routed();
    for (const method of ["completion/complete", "sampling/createMessage"]) {
      await expect(
        gateway.authorizeMcpEgress(ask(method)),
      ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    }
  });

  test("a gateway with no key for its grants answers 503, retryable", async () => {
    const { gateway, asked } = routed(false);
    await expect(
      gateway.authorizeMcpEgress(ask("tools/list")),
    ).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    expect(asked).toEqual([]);
  });
});
