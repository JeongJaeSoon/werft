import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  runtimeConfigSchema,
} from "@werft-ai/contracts";

import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
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

function claimWith(
  result: ClaimResult,
  capabilities?: { user_env: true },
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

describe("user variables in the claim, across worker versions", () => {
  test("a worker that announced user_env gets the values in runtime_config.env", async () => {
    const { claim, asked } = claimWith(
      {
        outcome: "claimed",
        binding: {
          ...binding,
          env: { REGION: "ap-northeast-1", TEAM: "core" },
        },
      },
      { user_env: true },
    );
    const response = (await claim) as {
      runtime_config: Record<string, unknown>;
    };
    expect(response.runtime_config.env).toEqual({
      REGION: "ap-northeast-1",
      TEAM: "core",
    });
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
    expect(asked[0]?.userEnv).toBe(true);
  });

  test("a session without variables claims as before, with no env key, for either kind of worker", async () => {
    for (const capabilities of [undefined, { user_env: true as const }]) {
      const { claim } = claimWith(
        { outcome: "claimed", binding },
        capabilities,
      );
      const response = (await claim) as {
        runtime_config: Record<string, unknown>;
      };
      expect(Object.keys(response.runtime_config)).not.toContain("env");
      // What a worker from before `env` parses: its schema is strict.
      expect(
        runtimeConfigSchema
          .omit({ env: true })
          .safeParse(response.runtime_config).success,
      ).toBe(true);
    }
  });

  test("a worker that did not announce user_env is not asked to carry values: the claim says unsupported and answers 503", async () => {
    const { claim, asked } = claimWith({ outcome: "user_env_unsupported" });
    await expect(claim).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    expect(asked[0]?.userEnv).toBeUndefined();
  });
});
