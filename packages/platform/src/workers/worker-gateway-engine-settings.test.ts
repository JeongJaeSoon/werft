import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  runtimeConfigSchema,
} from "@werft-ai/contracts";

import { acceptAllCheckpoints } from "../checkpoints/ports/checkpoint-verifier.ts";
import type { WorkerPendingStore } from "../ports/pending-requests.ts";
import type {
  ClaimInput,
  ClaimResult,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { CatalogProfile } from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  repository: "optional",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value: "anthropic-key", ref: { value_env: "K" } },
  },
};
const catalog = withSeededInstallation({
  profiles: { p: profile },
  repositories: {},
});

const binding = {
  sessionId: SESSION,
  attemptId: "att_1",
  profileId: "p",
  model: profile.model,
  githubPolicySource: "release",
  costUsd: 0,
  providerTokens: 0,
  repository: null,
  leaseEpoch: 1,
  executionGeneration: 1,
  authRevision: 0,
  leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
  leaseRemainingMs: 29_950,
  profileFingerprint: null,
  unmetered: false,
  ownerScope: "owner-a",
  restore: null,
  restoreProfiles: [],
  grants: [],
};

type Capabilities = { engine_settings?: true; permission_rules?: true };

function claimWith(
  result: ClaimResult,
  capabilities?: Capabilities,
): { claim: Promise<unknown>; asked: ClaimInput[] } {
  const asked: ClaimInput[] = [];
  const work = new Proxy(
    {
      claimAtomic: async (input: ClaimInput) => {
        asked.push(input);
        return result;
      },
    },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        return () => {
          throw new Error(`not reached: ${String(key)}`);
        };
      },
    },
  ) as unknown as WorkerUnitOfWork;
  const gateway = createWorkerGateway({
    work,
    catalog,
    pending: {} as unknown as WorkerPendingStore,
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
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

describe("saved engine rules in the claim", () => {
  test("a worker that announced both capabilities gets the merged rules", async () => {
    const { claim, asked } = claimWith(
      {
        outcome: "claimed",
        binding: {
          ...binding,
          engineSettings: {
            engine: { permissions: { ask: ["Bash(git push:*)"] } },
            disallowedTools: ["Skill"],
          },
        },
      },
      { engine_settings: true, permission_rules: true },
    );
    const response = (await claim) as {
      runtime_config: Record<string, unknown>;
    };
    expect(response.runtime_config.engine_settings).toEqual({
      permissions: { ask: ["Bash(git push:*)"] },
    });
    expect(response.runtime_config.disallowed_tools).toEqual(["Skill"]);
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
    expect(asked[0]?.engineSettingsCaps).toEqual({
      engineSettings: true,
      permissionRules: true,
    });
  });

  test("the capabilities are passed on exactly as announced", async () => {
    for (const [capabilities, expected] of [
      [undefined, { engineSettings: false, permissionRules: false }],
      [
        { engine_settings: true as const },
        { engineSettings: true, permissionRules: false },
      ],
      [
        { permission_rules: true as const },
        { engineSettings: false, permissionRules: true },
      ],
    ] as const) {
      const { claim, asked } = claimWith(
        { outcome: "claimed", binding },
        capabilities,
      );
      await claim;
      expect(asked[0]?.engineSettingsCaps).toEqual(expected);
    }
  });

  test("a session without saved rules claims as before, with neither key", async () => {
    const { claim } = claimWith({ outcome: "claimed", binding });
    const response = (await claim) as {
      runtime_config: Record<string, unknown>;
    };
    expect(Object.keys(response.runtime_config)).not.toContain(
      "engine_settings",
    );
    expect(Object.keys(response.runtime_config)).not.toContain(
      "disallowed_tools",
    );
    // What a worker from before the fields parses: its schema is strict.
    expect(
      runtimeConfigSchema
        .omit({ engine_settings: true, disallowed_tools: true })
        .safeParse(response.runtime_config).success,
    ).toBe(true);
  });

  test("a worker lacking a needed capability is answered 503 and retryable", async () => {
    const { claim } = claimWith({ outcome: "engine_settings_unsupported" });
    await expect(claim).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
  });

  test("rules that cannot be read refuse the claim without a retry", async () => {
    const { claim } = claimWith({
      outcome: "engine_settings_closed",
      reason: "agent_rules",
    });
    await expect(claim).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    });
    await expect(claim).rejects.not.toMatchObject({ retryable: true });
  });
});
