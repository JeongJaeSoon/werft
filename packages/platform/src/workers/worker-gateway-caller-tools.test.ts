import { describe, expect, test } from "bun:test";
import { bootstrapClaimResponseSchema } from "@werft-ai/contracts";
import type {
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import { withoutDeniedTools } from "../sessions/catalog.ts";
import {
  testBinding,
  testCatalog,
  testSpecSource,
} from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const TOOLS = ["Read", "Bash", "Write"];

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

async function claim(extra: Partial<WorkerBinding> = {}) {
  const binding = testBinding({
    spec: testSpecSource({ tools: TOOLS }),
    ...extra,
  });
  const gateway = createWorkerGateway({
    work: work({
      claimAtomic: async () => ({ outcome: "claimed", binding }),
    }),
    catalog: testCatalog(),
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
    },
  });
  const response = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
    },
  );
  expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  // Every claim mints its own tokens; the rest has to compare equal.
  return JSON.parse(
    JSON.stringify(response, (key, value) =>
      key === "token" || key === "session_credential" ? "minted" : value,
    ),
  ) as typeof response;
}

describe("a pinned caller limit's built-in tools_deny reaches the claim", () => {
  test("a denied built-in tool is not in runtime_config.tools", async () => {
    const response = await claim({ callerToolsDeny: ["Bash"] });
    expect(response.runtime_config.tools).toEqual(["Read", "Write"]);
  });

  test("a denied tool the list never held changes nothing, and offers no restore candidate", async () => {
    const response = await claim({ callerToolsDeny: ["WebSearch"] });
    expect(response.runtime_config.tools).toEqual(TOOLS);
    expect(response.restore_runtime_configs).toBeUndefined();
  });

  test("an old session with no or an empty limit claims what it always did", async () => {
    const before = await claim();
    const after = await claim({ callerToolsDeny: [] });
    expect(after).toEqual(before);
    expect(before.runtime_config.tools).toEqual(TOOLS);
    expect(before.restore_runtime_configs).toBeUndefined();
  });

  test("the session is still offered the list its checkpoints were made with", async () => {
    const response = await claim({ callerToolsDeny: ["Bash"] });
    expect(response.runtime_config.tools).toEqual(["Read", "Write"]);
    expect(
      response.restore_runtime_configs?.map((config) => config.tools),
    ).toEqual([TOOLS]);
  });
});

describe("MCP decisions do not move with the limit", () => {
  test("mcp__ names in tools_deny are not filtered here", () => {
    const tools = ["Read", "mcp__github__push", "Bash"];
    expect(withoutDeniedTools(tools, ["mcp__github__push"])).toBe(tools);
    expect(withoutDeniedTools(tools, ["Bash", "mcp__github__push"])).toEqual([
      "Read",
      "mcp__github__push",
    ]);
  });

  test("the claim differs from an unlimited one only in the built-in list", async () => {
    // The built-in names are what a limit may change; MCP names are kept, so
    // each list is compared by its `mcp__` entries and everything else whole.
    const mcpOnly = <C extends { tools: string[] }>(config: C) => ({
      ...config,
      tools: config.tools.filter((tool) => tool.startsWith("mcp__")),
    });
    const strip = <
      T extends {
        runtime_config: { tools: string[] };
        restore_runtime_configs?: { tools: string[] }[] | undefined;
      },
    >(
      response: T,
    ) => ({
      ...response,
      runtime_config: mcpOnly(response.runtime_config),
      restore_runtime_configs: response.restore_runtime_configs?.map(mcpOnly),
    });
    const github = {
      githubMcp: { releaseId: "rel-1", tools: ["mcp__github__request_push"] },
    };
    const limited = await claim({
      ...github,
      callerToolsDeny: ["Bash", "mcp__github__request_push"],
    });
    const open = await claim(github);
    expect(limited.runtime_config.tools).toEqual([
      "Read",
      "Write",
      "mcp__github__request_push",
    ]);
    expect(open.runtime_config.tools).toContain("mcp__github__request_push");
    expect(limited.runtime_config.mcp_servers?.map((s) => s.name)).toEqual([
      "github",
    ]);
    expect(strip(limited).runtime_config).toEqual(strip(open).runtime_config);
  });
});
