import { describe, expect, test } from "bun:test";
import { runtimeConfigSchema } from "@werft-ai/contracts";

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

function claimWith(
  result: ClaimResult,
  capabilities?: { response_language: true },
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

describe("the answer language in the claim, across worker versions", () => {
  const configOf = async (
    releaseLanguage: "ko" | "en" | "ja" | null | undefined,
    capabilities?: { response_language: true },
  ) => {
    const { claim } = claimWith(
      {
        outcome: "claimed",
        binding: {
          ...binding,
          ...(releaseLanguage === undefined ? {} : { releaseLanguage }),
        },
      },
      capabilities,
    );
    return ((await claim) as { runtime_config: Record<string, unknown> })
      .runtime_config;
  };

  test.each(["ko", "en", "ja"] as const)(
    "a worker that announced response_language gets %s in runtime_config",
    async (language) => {
      const config = await configOf(language, { response_language: true });
      expect(config.response_language).toBe(language);
      expect(runtimeConfigSchema.safeParse(config).success).toBe(true);
    },
  );

  test("a worker that did not announce it gets no key, so its strict schema still parses the claim", async () => {
    const config = await configOf("ja");
    expect(Object.keys(config)).not.toContain("response_language");
    expect(
      runtimeConfigSchema.omit({ response_language: true }).safeParse(config)
        .success,
    ).toBe(true);
  });

  test("follow-user, a release before the field and a session without a release send no key to either kind of worker", async () => {
    for (const capabilities of [
      undefined,
      { response_language: true as const },
    ]) {
      for (const language of [null, undefined]) {
        const config = await configOf(language, capabilities);
        expect(Object.keys(config)).not.toContain("response_language");
      }
    }
  });
});
