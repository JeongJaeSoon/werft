import { describe, expect, test } from "bun:test";
import { bootstrapClaimResponseSchema } from "@werft-ai/contracts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type {
  ClaimInput,
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { CatalogConnection } from "../sessions/catalog.ts";
import {
  testBinding,
  testCatalog,
  testConnection,
  testSpecSource,
} from "../testing/catalog-fakes.ts";
import {
  LEGACY_CONFIG_TOKEN,
  storableLegacyConfig,
} from "./legacy-runtime-configs.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const connection: CatalogConnection = testConnection({
  models: ["sonnet-5-1", "opus-5-0"],
  model_families: {
    "sonnet-5-0": { family: "sonnet", rank: 0 },
    "sonnet-5-1": { family: "sonnet", rank: 1 },
    "opus-5-0": { family: "opus", rank: 0 },
    "opus-4-9": { family: "opus", rank: -1 },
    "sonnet-6-0": { family: "sonnet-next", rank: 0 },
  },
});

/** Every unit-of-work call these tests do not expect throws. */
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

function claimWith(
  over: CatalogConnection,
  bound: Partial<Pick<WorkerBinding, "legacyRuntimeConfigs">> = {},
  accepted?: string[],
) {
  const seen: ClaimInput[] = [];
  const spec = testSpecSource({ model: "sonnet-5-1" });
  const gateway = createWorkerGateway({
    work: work({
      claimAtomic: async (input) => {
        seen.push(input);
        return {
          outcome: "claimed",
          binding: testBinding({ spec, ...bound }),
        };
      },
    }),
    catalog: testCatalog({
      connections: { "conn-1": over },
      ...(accepted === undefined
        ? {}
        : { runtime_versions: { accepted, current: ["0.3.270", "2.1.270"] } }),
    }),
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
    },
  });
  const claimed = gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
    },
  );
  return { claimed, seen };
}

describe("run configs kept on the session row, at claim", () => {
  const kept = async () => {
    const live = (await claimWith(connection).claimed).runtime_config;
    // What a model move stores: the earlier model, no credential.
    return storableLegacyConfig({
      ...live,
      model: "sonnet-5-0",
      permission_mode: "bypassPermissions",
    });
  };

  test("are offered as restore configs with this claim's token and their original mode", async () => {
    const stored = await kept();
    expect(JSON.stringify(stored)).toContain(LEGACY_CONFIG_TOKEN);
    const response = await claimWith(connection, {
      legacyRuntimeConfigs: [stored],
    }).claimed;
    const [offered] = response.restore_runtime_configs ?? [];
    expect(offered).toMatchObject({
      model: "sonnet-5-0",
      permission_mode: "bypassPermissions",
      provider: { auth: response.runtime_config.provider.auth },
    });
    expect(JSON.stringify(response)).not.toContain(LEGACY_CONFIG_TOKEN);
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  test("the same config kept twice is offered once", async () => {
    const stored = await kept();
    const response = await claimWith(connection, {
      legacyRuntimeConfigs: [stored, stored],
    }).claimed;
    expect(
      response.restore_runtime_configs?.map(
        (c) => `${c.model}/${c.permission_mode}`,
      ),
    ).toEqual(["sonnet-5-0/bypassPermissions"]);
  });

  test("an entry that no longer parses, or no entry, offers nothing", async () => {
    for (const legacyRuntimeConfigs of [null, undefined, {}, [{ model: 1 }]]) {
      const response = await claimWith(connection, { legacyRuntimeConfigs })
        .claimed;
      expect(response.restore_runtime_configs).toBeUndefined();
    }
  });
});

describe("what a claim asks the store to match", () => {
  test("each connection with the models it offers, and the runtime versions it accepts", async () => {
    const { claimed, seen } = claimWith(connection, {}, ["0.3.270", "0.3.250"]);
    await claimed;
    expect(seen[0]?.runnable.connections).toEqual([
      { id: "conn-1", models: ["sonnet-5-1", "opus-5-0"] },
    ]);
    expect(seen[0]?.runnable.runtimeVersions).toEqual(["0.3.270", "0.3.250"]);
    expect([...(seen[0]?.unsettledConnectionIds ?? [])]).toEqual([]);
  });

  test("no accepted list leaves the runtime version open", async () => {
    const { claimed, seen } = claimWith(connection);
    await claimed;
    expect(seen[0]?.runnable.runtimeVersions).toBeNull();
  });
});

describe("a model that left the list, at claim", () => {
  test("hands the claim every removed model's one-step successor on its connection", async () => {
    const { claimed, seen } = claimWith(connection);
    await claimed;
    expect(seen[0]?.modelMoves).toEqual([
      { connectionId: "conn-1", from: "sonnet-5-0", to: "sonnet-5-1" },
      { connectionId: "conn-1", from: "opus-4-9", to: "opus-5-0" },
    ]);
  });

  test("a connection with no family table hands over nothing", async () => {
    const { model_families: _gone, ...plain } = connection;
    const { claimed, seen } = claimWith(plain);
    await claimed;
    expect(seen[0]?.modelMoves).toEqual([]);
  });

  test("a session moved off sonnet-5-0 runs its new model and still restores the checkpoint it made there", async () => {
    const before = (await claimWith(connection).claimed).runtime_config;
    const response = await claimWith(connection, {
      legacyRuntimeConfigs: [
        storableLegacyConfig({ ...before, model: "sonnet-5-0" }),
      ],
    }).claimed;
    expect(response.runtime_config.model).toBe("sonnet-5-1");
    expect(response.restore_runtime_configs?.map((c) => c.model)).toEqual([
      "sonnet-5-0",
    ]);
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });
});
