import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  GITHUB_MCP_TOOLS,
  githubMcpToolNames,
} from "@werft-ai/contracts";
import type { CatalogConnection } from "../catalog/catalog.ts";
import type {
  ClaimInput,
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  testBinding,
  testCatalog,
  testConnection,
  testSpecSource,
} from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import {
  LEGACY_CONFIG_TOKEN,
  storableLegacyConfig,
} from "./legacy-runtime-configs.ts";
import {
  createWorkerGateway,
  earlierGitHubServers,
  GITHUB_TOOL_ADDITIONS,
} from "./worker-gateway.ts";

const connection: CatalogConnection = testConnection({
  models: ["sonnet-5-1", "opus-5-0"],
  model_families: {
    "sonnet-5-0": { family: "sonnet", rank: 0 },
    "sonnet-5-1": { family: "sonnet", rank: 1 },
    "opus-5-0": { family: "opus", rank: 0 },
    "opus-4-9": { family: "opus", rank: -1 },
    "sonnet-6-0": { family: "sonnet-next", rank: 0 },
  },
});

/** Every unit-of-work call these tests do not expect throws. */
function work(overrides: Partial<WorkerUnitOfWork>): WorkerUnitOfWork {
  return new Proxy(overrides, {
    get(target, key) {
      if (key in target) return target[key as keyof WorkerUnitOfWork];
      return () => {
        throw new Error(`not reached: ${String(key)}`);
      };
    },
  }) as WorkerUnitOfWork;
}

function claimWith(
  over: CatalogConnection,
  bound: Partial<
    Pick<WorkerBinding, "legacyRuntimeConfigs" | "githubMcp">
  > = {},
  accepted?: { kind: string; engine: string; version: string }[],
  engine?: string,
) {
  const seen: ClaimInput[] = [];
  const spec = testSpecSource({ model: "sonnet-5-1" });
  const gateway = createWorkerGateway({
    work: work({
      claimAtomic: async (input) => {
        seen.push(input);
        return {
          outcome: "claimed",
          binding: testBinding({ spec, ...bound }),
        };
      },
    }),
    catalog: testCatalog({
      connections: { "conn-1": over },
      ...(accepted === undefined ? {} : { runtime_versions: { accepted } }),
    }),
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 30_000,
    },
  });
  const claimed = gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
      ...(engine === undefined
        ? {}
        : {
            image_runtime: {
              engine,
              sdk_version: "0.3.270",
              cli_version: "2.1.270",
              profile_digest_scheme: 1,
            },
          }),
    },
  );
  return { claimed, seen };
}

describe("run configs kept on the session row, at claim", () => {
  const kept = async () => {
    const live = (await claimWith(connection).claimed).runtime_config;
    // What a model move stores: the earlier model, no credential.
    return storableLegacyConfig({
      ...live,
      model: "sonnet-5-0",
      permission_mode: "bypassPermissions",
    });
  };

  test("are offered as restore configs with this claim's token and their original mode", async () => {
    const stored = await kept();
    expect(JSON.stringify(stored)).toContain(LEGACY_CONFIG_TOKEN);
    const response = await claimWith(connection, {
      legacyRuntimeConfigs: [stored],
    }).claimed;
    // After the running config as it was before `werft`: the kept one with
    // `werft` and without it.
    const [, ...offered] = response.restore_runtime_configs ?? [];
    expect(offered.map((c) => (c.mcp_servers ?? []).length)).toEqual([1, 0]);
    for (const config of offered) {
      expect(config).toMatchObject({
        model: "sonnet-5-0",
        permission_mode: "bypassPermissions",
        provider: { auth: response.runtime_config.provider.auth },
      });
    }
    expect(JSON.stringify(response)).not.toContain(LEGACY_CONFIG_TOKEN);
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  test("the same config kept twice is offered once", async () => {
    const stored = await kept();
    const response = await claimWith(connection, {
      legacyRuntimeConfigs: [stored, stored],
    }).claimed;
    expect(
      response.restore_runtime_configs?.map(
        (c) =>
          `${c.model}/${c.permission_mode}/${(c.mcp_servers ?? []).map((s) => s.name)}`,
      ),
    ).toEqual([
      "sonnet-5-1/auto/",
      "sonnet-5-0/bypassPermissions/werft",
      "sonnet-5-0/bypassPermissions/",
    ]);
  });

  test("with github tools added, the configs offered before keep their places and the earlier lists fill what the cap leaves", async () => {
    const live = (await claimWith(connection).claimed).runtime_config;
    const shapesWith = async (count: number) => {
      const models = Array.from({ length: count }, (_, at) => `sonnet-4-${at}`);
      const response = await claimWith(connection, {
        legacyRuntimeConfigs: models.map((model) =>
          storableLegacyConfig({ ...live, model }),
        ),
        githubMcp: {
          releaseId: "rel-1",
          tools: [
            "mcp__github__request_push",
            "mcp__github__merge_pull_request",
            "mcp__github__get_pull_request",
          ],
        },
      }).claimed;
      return {
        models,
        shapes: (response.restore_runtime_configs ?? []).map(
          (config) =>
            `${config.model} ${(config.mcp_servers ?? []).length} ${config.tools.filter((tool) => tool.startsWith("mcp__github__")).length}`,
        ),
      };
    };
    // What the claim offers before any earlier list: the running config
    // before `werft` and without `github`, then each kept one with both
    // servers, before `werft` and without `github`.
    const before = (models: string[]) => [
      "sonnet-5-1 1 3",
      "sonnet-5-1 0 0",
      ...models.flatMap((model) => [
        `${model} 2 3`,
        `${model} 1 3`,
        `${model} 0 0`,
      ]),
    ];
    // The running config before get_pull_request, then each kept one the
    // same way, to the cap. Every earlier list is from before `werft`.
    const three = await shapesWith(3);
    expect(three.shapes).toEqual([
      ...before(three.models),
      "sonnet-5-1 1 2",
      ...three.models.map((model) => `${model} 1 2`),
    ]);
    const four = await shapesWith(4);
    expect(four.shapes).toEqual([
      ...before(four.models),
      "sonnet-5-1 1 2",
      `${four.models[0]} 1 2`,
    ]);
    // Five kept configs already overflow the cap: the first 16 of them.
    const five = await shapesWith(5);
    expect(five.shapes).toEqual(before(five.models).slice(0, 16));
  });

  // The earlier lists are offered without the built-in `werft` server,
  // since both additions so far were made before it was attached. The next
  // one is made after: its earlier list has to be offered with `werft` too
  // (`offeredFor` in worker-gateway.ts), and then this count moves.
  test("no github tool was added after the built-in werft server was attached", () => {
    expect(GITHUB_TOOL_ADDITIONS).toHaveLength(2);
  });

  test("every github tool has its place in the order the server gained them", () => {
    const listed: string[] = GITHUB_TOOL_ADDITIONS.flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.keys(GITHUB_MCP_TOOLS).sort());
  });

  test("each earlier list leaves out its addition and every later one, newest first, and a list the server never held is not offered", () => {
    const server = {
      name: "github",
      endpoint: "http://egress/mcp/github",
      binding: "rel-1",
      tools: githubMcpToolNames([
        "request_push",
        "merge_pull_request",
        "get_pull_request",
      ]),
      trusted: githubMcpToolNames(["request_push", "get_pull_request"]),
    };
    const lists = earlierGitHubServers(server, [
      ["request_push"],
      ["merge_pull_request"],
      ["dispatch_workflow"],
      ["get_pull_request"],
    ]).map(({ tools, trusted }) => ({ tools, trusted }));
    expect(lists).toEqual([
      {
        tools: githubMcpToolNames(["request_push", "merge_pull_request"]),
        trusted: githubMcpToolNames(["request_push"]),
      },
      {
        tools: githubMcpToolNames(["request_push"]),
        trusted: githubMcpToolNames(["request_push"]),
      },
    ]);
  });

  test("an entry that no longer parses, or no entry, offers nothing of its own", async () => {
    for (const legacyRuntimeConfigs of [null, undefined, {}, [{ model: 1 }]]) {
      const response = await claimWith(connection, { legacyRuntimeConfigs })
        .claimed;
      // Only the running config as it was before `werft`.
      const { mcp_servers: _, ...beforeWerft } = response.runtime_config;
      expect(response.restore_runtime_configs).toEqual([beforeWerft]);
    }
  });
});

describe("what a claim asks the store to match", () => {
  test("each connection with the models it offers, and the runtime versions it accepts", async () => {
    const accepted = [
      { kind: "claude_agent_sdk", engine: "claude", version: "0.3.270" },
      { kind: "codex_app_server", engine: "codex", version: "0.3.250" },
    ];
    const { claimed, seen } = claimWith(connection, {}, accepted);
    await claimed;
    expect(seen[0]?.runnable.connections).toEqual([
      { id: "conn-1", models: ["sonnet-5-1", "opus-5-0"] },
    ]);
    expect(seen[0]?.runnable.runtimeVersions).toEqual(accepted);
    expect([...(seen[0]?.unsettledConnectionIds ?? [])]).toEqual([]);
  });

  test("each pair with its engine and the worker's own runtime, for the store to narrow by", async () => {
    const accepted = [
      { kind: "claude_agent_sdk", engine: "claude", version: "0.3.270" },
      { kind: "codex_app_server", engine: "codex", version: "0.3.270" },
    ];
    const { claimed, seen } = claimWith(connection, {}, accepted, "codex");
    await claimed;
    expect(seen[0]?.runnable.runtimeVersions).toEqual(accepted);
    expect(seen[0]?.imageRuntime?.engine).toBe("codex");
  });

  test("no accepted list leaves the runtime version open", async () => {
    const { claimed, seen } = claimWith(connection);
    await claimed;
    expect(seen[0]?.runnable.runtimeVersions).toBeNull();
  });
});

describe("a model that left the list, at claim", () => {
  test("hands the claim every removed model's one-step successor on its connection", async () => {
    const { claimed, seen } = claimWith(connection);
    await claimed;
    expect(seen[0]?.modelMoves).toEqual([
      { connectionId: "conn-1", from: "sonnet-5-0", to: "sonnet-5-1" },
      { connectionId: "conn-1", from: "opus-4-9", to: "opus-5-0" },
    ]);
  });

  test("a connection with no family table hands over nothing", async () => {
    const { model_families: _gone, ...plain } = connection;
    const { claimed, seen } = claimWith(plain);
    await claimed;
    expect(seen[0]?.modelMoves).toEqual([]);
  });

  test("a session moved off sonnet-5-0 runs its new model and still restores the checkpoint it made there", async () => {
    const before = (await claimWith(connection).claimed).runtime_config;
    const response = await claimWith(connection, {
      legacyRuntimeConfigs: [
        storableLegacyConfig({ ...before, model: "sonnet-5-0" }),
      ],
    }).claimed;
    expect(response.runtime_config.model).toBe("sonnet-5-1");
    // The new model as it ran before `werft`, then the old one with
    // `werft` and without it.
    expect(response.restore_runtime_configs?.map((c) => c.model)).toEqual([
      "sonnet-5-1",
      "sonnet-5-0",
      "sonnet-5-0",
    ]);
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });
});
