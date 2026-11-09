import { describe, expect, test } from "bun:test";
import { bootstrapClaimResponseSchema } from "@werft-ai/contracts";
import { releaseSpecRecord } from "../agents/release-spec.ts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type { WorkerPendingStore } from "../ports/pending-requests.ts";
import type {
  ClaimResult,
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  type CatalogProfile,
  profileFingerprint,
  type SessionCatalog,
} from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep"],
  permission_mode: "default",
  repository: "optional",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value: "anthropic-key", ref: { value_env: "K" } },
  },
};

const spec = releaseSpecRecord({
  derivation_version: 1,
  origin: "profile",
  release_id: "rel-1",
  release_id_version: 2,
  profile_id: "p",
  profile_digest: "digest",
  runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
  connection: {
    id: "conn-1",
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    billing: "per_token",
  },
  model: "claude-sonnet-5",
  permission_mode: "bypassPermissions",
  tools: ["Read"],
  repository_mode: "optional",
}).runtime_spec;

const PINNED = `sha256:${"a".repeat(64)}`;

const base: WorkerBinding = {
  sessionId: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  attemptId: "att_1",
  profileId: "p",
  model: "claude-sonnet-5",
  githubPolicySource: "release",
  costUsd: 0,
  providerTokens: 0,
  repository: null,
  leaseEpoch: 1,
  executionGeneration: 1,
  authRevision: 0,
  leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
  leaseRemainingMs: 29_950,
  profileFingerprint: PINNED,
  unmetered: false,
  ownerScope: "owner-a",
  restore: null,
  restoreProfiles: [],
  grants: [],
} as unknown as WorkerBinding;

function claim(binding: WorkerBinding, catalog: SessionCatalog) {
  const result: ClaimResult = { outcome: "claimed", binding };
  const work = new Proxy(
    { claimAtomic: async () => result },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        return () => {
          throw new Error(`not reached: ${String(key)}`);
        };
      },
    },
  ) as unknown as WorkerUnitOfWork;
  return createWorkerGateway({
    work,
    catalog,
    pending: {} as unknown as WorkerPendingStore,
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
    },
  }).bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
    },
  );
}

const without: SessionCatalog = { profiles: {}, repositories: {} };
const withProfile = withSeededInstallation({
  profiles: { p: profile },
  repositories: {},
});

describe("a claim for a release whose profile the catalog no longer has", () => {
  test("runs the release's spec under the fingerprint the row pinned", async () => {
    const response = await claim(
      { ...base, model: "claude-opus-5", releaseSpec: spec },
      without,
    );
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
    expect(response.profile_fingerprint).toBe(PINNED);
    expect(response.runtime).toEqual({
      kind: "claude_agent_sdk",
      version: "0.3.270",
      profile_id: "p",
    });
    // The session's own model, as with a profile; the spec's tools and mode.
    expect(response.runtime_config).toMatchObject({
      model: "claude-opus-5",
      tools: ["Read"],
      permission_mode: "bypassPermissions",
      provider: { kind: "anthropic", auth: { kind: "egress_token" } },
    });
    expect(JSON.stringify(response)).not.toContain("anthropic-key");
  });

  test("is refused as before when the release has no verified spec", async () => {
    for (const releaseSpec of [undefined, null]) {
      await expect(
        claim({ ...base, releaseSpec } as WorkerBinding, without),
      ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
    }
  });

  test("is refused when the row pinned no fingerprint", async () => {
    await expect(
      claim({ ...base, profileFingerprint: null, releaseSpec: spec }, without),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
  });
});

describe("a claim whose profile is still in the catalog", () => {
  test("reads the profile, not the spec", async () => {
    const response = await claim(
      {
        ...base,
        profileFingerprint: profileFingerprint(profile),
        releaseSpec: { ...spec, model: "from-the-spec" },
      },
      withProfile,
    );
    expect(response.runtime_config).toMatchObject({
      model: "claude-sonnet-5",
      permission_mode: "default",
      tools: ["Read", "Grep"],
    });
  });

  // Widening this would let a session run on a release it no longer matches.
  test("a profile that changed since the row pinned it is still refused", async () => {
    await expect(
      claim({ ...base, releaseSpec: spec }, withProfile),
    ).rejects.toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
  });
});
