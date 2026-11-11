import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  type ClaimTelemetry,
  nextInputResponseSchema,
  type TraceContentMode,
} from "@werft-ai/contracts";

import { acceptAllCheckpoints } from "../checkpoints/ports/checkpoint-verifier.ts";
import type { WorkerPendingStore } from "../ports/pending-requests.ts";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import type { CatalogProfile } from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import {
  type ClaimTelemetrySource,
  createWorkerGateway,
} from "./worker-gateway.ts";

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

const scope = {
  session_id: SESSION,
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};
const principal = {
  kind: "session",
  attemptId: "att_1",
  sessionId: SESSION,
  leaseEpoch: 1,
  executionGeneration: 1,
  authRevision: 0,
} as const;

function build(telemetry: ClaimTelemetrySource | undefined) {
  const work = {
    claimAtomic: async () => ({ outcome: "claimed", binding }),
    nextInputAtomic: async (input: { now: Date }) => ({
      outcome: "ok",
      leaseExpiresAt: new Date(input.now.getTime() + 30_000),
      input: {
        turnId: "1",
        inputId: "7",
        message: "go",
        deliveryStartedAt: input.now,
        actorId: null,
        traceContext: null,
      },
    }),
  } as unknown as WorkerUnitOfWork;
  return createWorkerGateway({
    work,
    catalog,
    pending: {} as unknown as WorkerPendingStore,
    checkpoints: acceptAllCheckpoints,
    ...(telemetry === undefined ? {} : { telemetry }),
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
      maxWaitMs: 0,
    },
  });
}

function claim(telemetry: ClaimTelemetrySource | undefined) {
  return build(telemetry).bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
    },
  );
}

function source(mode: TraceContentMode | undefined): ClaimTelemetrySource {
  const on: ClaimTelemetry = {
    enabled: true,
    ingest_url: "http://api.internal:4319",
    content_mode: mode ?? "full",
    content_max_bytes: 32768,
    sampler: "traceidratio",
    sampler_arg: 0.5,
  };
  return {
    claim: () => (mode === undefined ? { enabled: false } : on),
    contentMode: () => mode,
  };
}

describe("claim telemetry", () => {
  test("a source that is off puts `enabled: false` in the claim", async () => {
    const response = await claim(source(undefined));
    expect(response.telemetry).toEqual({ enabled: false });
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  test("an enabled source puts its address, limits and sampler in the claim", async () => {
    const response = await claim(source("metadata"));
    expect(response.telemetry).toEqual({
      enabled: true,
      ingest_url: "http://api.internal:4319",
      content_mode: "metadata",
      content_max_bytes: 32768,
      sampler: "traceidratio",
      sampler_arg: 0.5,
    });
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  test("without a source the claim has no telemetry key, as before", async () => {
    expect("telemetry" in (await claim(undefined))).toBe(false);
  });
});

describe("nextInput content_mode", () => {
  const ask = async (telemetry: ClaimTelemetrySource | undefined) =>
    build(telemetry).nextInput(principal, scope);

  test("carries the mode the source resolves, every turn", async () => {
    const response = await ask(source("metadata"));
    expect(response.input?.content_mode).toBe("metadata");
    expect(nextInputResponseSchema.safeParse(response).success).toBe(true);
  });

  test("is left out while tracing is off or without a source", async () => {
    expect("content_mode" in ((await ask(source(undefined))).input ?? {})).toBe(
      false,
    );
    expect("content_mode" in ((await ask(undefined)).input ?? {})).toBe(false);
  });
});
