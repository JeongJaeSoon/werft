import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  type PermissionMode,
} from "@werft-ai/contracts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type {
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  testBinding,
  testCatalog,
  testSpecSource,
} from "../testing/catalog-fakes.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

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

/** One claim of a session whose spec runs `mode`. */
async function claim(mode: PermissionMode, extra: Partial<WorkerBinding> = {}) {
  const binding = testBinding({
    spec: testSpecSource({ permission_mode: mode }),
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
  return response;
}

describe("the mode a claim runs", () => {
  test("is the session spec's, whatever the connection says now", async () => {
    for (const mode of ["default", "auto", "bypassPermissions"] as const) {
      expect((await claim(mode)).runtime_config.permission_mode).toBe(mode);
    }
  });
});

describe("restore candidates", () => {
  test("a session that ran one config only is offered no candidate", async () => {
    expect((await claim("default")).restore_runtime_configs).toBeUndefined();
  });

  test("a session whose model moved is offered the config it ran before", async () => {
    const before = await claim("default");
    const response = await claim("default", {
      legacyRuntimeConfigs: [
        { ...before.runtime_config, model: "claude-sonnet-4" },
        { not: "a config" },
      ],
    });
    expect(
      response.restore_runtime_configs?.map((config) => config.model),
    ).toEqual(["claude-sonnet-4"]);
    // Each candidate carries this claim's own provider token.
    expect(response.restore_runtime_configs?.[0]?.provider.auth).toEqual(
      response.runtime_config.provider.auth,
    );
  });
});
