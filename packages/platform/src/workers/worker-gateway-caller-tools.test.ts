import { describe, expect, test } from "bun:test";
import { bootstrapClaimResponseSchema } from "@werft-ai/contracts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type {
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  type CatalogProfile,
  profileFingerprint,
  withoutDeniedTools,
} from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "sonnet-5-1",
  tools: ["Read", "Bash", "Write"],
  permission_mode: "bypassPermissions",
  repository: "none",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value: "provider-key", ref: { value_env: "K" } },
  },
};

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

async function claim(extra: Partial<WorkerBinding>, resuming = false) {
  const binding = {
    sessionId: SESSION,
    attemptId: "att_1",
    leaseEpoch: 1,
    executionGeneration: 1,
    authRevision: 0,
    leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
    leaseRemainingMs: 29_950,
    profileId: "p",
    profileFingerprint: profileFingerprint(profile),
    model: "sonnet-5-1",
    unmetered: false,
    ownerScope: "owner-a",
    repository: null,
    restore: null,
    restoreProfiles: resuming
      ? [
          {
            profileId: "p",
            profileFingerprint: profileFingerprint(profile),
            model: "sonnet-5-1",
          },
        ]
      : [],
    costUsd: 0,
    providerTokens: 0,
    ...extra,
  } as WorkerBinding;
  const gateway = createWorkerGateway({
    work: work({
      claimAtomic: async () => ({ outcome: "claimed", binding }),
    }),
    catalog: withSeededInstallation({
      profiles: { p: profile },
      repositories: {},
    }),
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
    const response = await claim({ callerToolsDeny: ["WebSearch"] }, true);
    expect(response.runtime_config.tools).toEqual(["Read", "Bash", "Write"]);
    expect(response.restore_runtime_configs).toBeUndefined();
  });

  test("a release session loses the denied tool from its own list", async () => {
    const response = await claim({
      runtimeToolsSource: "release",
      releaseEffectiveTools: ["Read", "Bash"],
      releaseTools: ["Read", "Bash"],
      callerToolsDeny: ["Bash"],
    });
    expect(response.runtime_config.tools).toEqual(["Read"]);
  });

  test("an old session with no or an empty limit claims what it always did", async () => {
    const before = await claim({}, true);
    for (const callerToolsDeny of [undefined, []]) {
      const after = await claim(
        callerToolsDeny === undefined ? {} : { callerToolsDeny },
        true,
      );
      expect(after).toEqual(before);
    }
    expect(before.runtime_config.tools).toEqual(["Read", "Bash", "Write"]);
    expect(before.restore_runtime_configs).toBeUndefined();
  });

  test("a resuming session is still offered the list its checkpoints were made with", async () => {
    const response = await claim({ callerToolsDeny: ["Bash"] }, true);
    expect(response.runtime_config.tools).toEqual(["Read", "Write"]);
    expect(
      response.restore_runtime_configs?.map((config) => config.tools),
    ).toEqual([["Read", "Bash", "Write"]]);
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
    expect(strip(limited)).toEqual(strip(open));
  });
});
