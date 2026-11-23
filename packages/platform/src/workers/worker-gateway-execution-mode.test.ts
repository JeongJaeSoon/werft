import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  type PlatformPrompt,
  type SpecSource,
} from "@werft-ai/contracts";
import type {
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  testBinding,
  testCatalog,
  testSpecSource,
} from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
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

/** One claim of a session whose spec recorded `mode`. */
async function claim(
  mode: SpecSource["permission_mode"],
  extra: Partial<WorkerBinding> = {},
) {
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
      sessionBudget: { costUsd: 1_000, tokens: null },
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
  // Before, a spec recorded as default ran default.
  test("is decided from the spec's Claude model, not the mode it recorded", async () => {
    for (const mode of ["default", "auto"] as const) {
      expect((await claim(mode)).runtime_config.permission_mode).toBe("auto");
    }
  });
});

describe("restore candidates", () => {
  test("a session that ran one config only is offered no candidate", async () => {
    expect((await claim("auto")).restore_runtime_configs).toBeUndefined();
  });

  // A digest scheme 1 checkpoint hashed the mode the session ran before a
  // claim decided it again.
  test("a spec recorded as default is offered its config in that mode", async () => {
    const response = await claim("default");
    expect(response.runtime_config.permission_mode).toBe("auto");
    expect(response.restore_runtime_configs).toEqual([
      { ...response.runtime_config, permission_mode: "default" },
    ]);
  });

  test("a session whose model moved is offered the config it ran before", async () => {
    const before = await claim("auto");
    const response = await claim("auto", {
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

describe("the row's platform prompt", () => {
  const prompt: PlatformPrompt = {
    prompt_revision: 1,
    agent_identity: { name: "code-review", description: null },
    origin_surface: "slack_channel",
    language: "ko",
    repository: "acme/app",
  };
  const configsOf = (response: Awaited<ReturnType<typeof claim>>) => [
    response.runtime_config,
    ...(response.restore_runtime_configs ?? []),
  ];

  test("rides the run config and the configs kept as they ran; a revision 0 row adds it nowhere", async () => {
    // A kept config is stored as it ran, the row's prompt included.
    const before = (await claim("auto", { platformPrompt: prompt }))
      .runtime_config;
    const prompted = await claim("auto", {
      platformPrompt: prompt,
      legacyRuntimeConfigs: [{ ...before, model: "claude-sonnet-4" }],
    });
    expect(configsOf(prompted)).toHaveLength(2);
    expect(configsOf(prompted).map((c) => c.platform_prompt)).toEqual([
      prompt,
      prompt,
    ]);
    const unprompted = (await claim("auto")).runtime_config;
    for (const platformPrompt of [null, undefined]) {
      const plain = await claim("auto", {
        legacyRuntimeConfigs: [{ ...unprompted, model: "claude-sonnet-4" }],
        ...(platformPrompt === undefined ? {} : { platformPrompt }),
      });
      expect(
        configsOf(plain).some((config) => "platform_prompt" in config),
      ).toBe(false);
    }
  });
});
