import { describe, expect, test } from "bun:test";
import { bootstrapClaimResponseSchema } from "@werft-ai/contracts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type {
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  type CatalogProfile,
  type ConnectionAutoMode,
  profileFingerprint,
} from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

const profile = (mode: CatalogProfile["permission_mode"]): CatalogProfile => ({
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "sonnet-5-1",
  tools: ["Read"],
  permission_mode: mode,
  repository: "none",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value: "provider-key", ref: { value_env: "K" } },
  },
});

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

/** One claim of a session on profile "p", whose connection is `autoMode`. */
async function claim(
  stored: CatalogProfile["permission_mode"],
  autoMode: ConnectionAutoMode | undefined,
  resuming = false,
) {
  const p = profile(stored);
  const binding: WorkerBinding = {
    sessionId: SESSION,
    attemptId: "att_1",
    leaseEpoch: 1,
    executionGeneration: 1,
    authRevision: 0,
    leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
    leaseRemainingMs: 29_950,
    profileId: "p",
    profileFingerprint: profileFingerprint(p),
    model: "sonnet-5-1",
    unmetered: false,
    ownerScope: "owner-a",
    repository: null,
    restore: null,
    restoreProfiles: resuming
      ? [
          {
            profileId: "p",
            profileFingerprint: profileFingerprint(p),
            model: "sonnet-5-1",
          },
        ]
      : [],
    costUsd: 0,
    providerTokens: 0,
  } as WorkerBinding;
  const asked: string[] = [];
  const gateway = createWorkerGateway({
    work: work({
      claimAtomic: async () => ({ outcome: "claimed", binding }),
    }),
    catalog: {
      ...withSeededInstallation({ profiles: { p }, repositories: {} }),
      ...(autoMode === undefined
        ? {}
        : {
            connection_auto_mode: (id: string) => {
              asked.push(id);
              return autoMode;
            },
          }),
    },
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
  return { response, asked };
}

describe("the mode a claim runs", () => {
  test("a convertible stored mode runs as auto only where the connection is known to support it", async () => {
    for (const stored of [
      "default",
      "acceptEdits",
      "dontAsk",
      "plan",
    ] as const) {
      expect(
        (await claim(stored, "supported")).response.runtime_config
          .permission_mode,
      ).toBe("auto");
      for (const autoMode of ["unsupported", "unknown", undefined] as const) {
        expect(
          (await claim(stored, autoMode)).response.runtime_config
            .permission_mode,
        ).toBe(stored);
      }
    }
  });

  test("auto and bypassPermissions run as they are stored, whatever the connection says", async () => {
    for (const stored of ["auto", "bypassPermissions"] as const) {
      for (const autoMode of ["supported", "unsupported", "unknown"] as const) {
        expect(
          (await claim(stored, autoMode)).response.runtime_config
            .permission_mode,
        ).toBe(stored);
      }
    }
  });

  test("the connection is asked about the session's profile", async () => {
    expect((await claim("default", "supported")).asked).toEqual(["p"]);
  });
});

describe("restore candidates across a mode conversion (scheme 1 hashes the mode)", () => {
  const modes = (configs: { permission_mode?: string }[] | undefined) =>
    configs?.map((config) => config.permission_mode);

  test("a session with nothing to resume is offered no candidate", async () => {
    const { response } = await claim("default", "supported", false);
    expect(response.restore_runtime_configs).toBeUndefined();
  });

  test("a resuming session on a converted connection is offered its stored mode too, so a checkpoint made before the conversion still matches", async () => {
    const { response } = await claim("default", "supported", true);
    expect(response.runtime_config.permission_mode).toBe("auto");
    expect(modes(response.restore_runtime_configs)).toEqual(["default"]);
  });

  test("a resuming session whose connection stopped converting is offered the auto mode a checkpoint may carry", async () => {
    for (const autoMode of ["unsupported", "unknown"] as const) {
      const { response } = await claim("default", autoMode, true);
      expect(response.runtime_config.permission_mode).toBe("default");
      expect(modes(response.restore_runtime_configs)).toEqual(["auto"]);
    }
  });

  test("a mode that is never converted gets no variant", async () => {
    for (const stored of ["auto", "bypassPermissions"] as const) {
      const { response } = await claim(stored, "supported", true);
      expect(response.restore_runtime_configs).toBeUndefined();
    }
  });
});
