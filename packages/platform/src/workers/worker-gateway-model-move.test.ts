import { describe, expect, test } from "bun:test";
import { bootstrapClaimResponseSchema } from "@werft-ai/contracts";
import { acceptAllCheckpoints } from "../checkpoints/ports/checkpoint-verifier.ts";
import type {
  ClaimInput,
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  type CatalogProfile,
  modelMovePins,
  profileFingerprint,
} from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "sonnet-5-1",
  models: ["sonnet-5-1", "opus-5-0"],
  model_families: {
    "sonnet-5-0": { family: "sonnet", rank: 0 },
    "sonnet-5-1": { family: "sonnet", rank: 1 },
    "opus-5-0": { family: "opus", rank: 0 },
    "opus-4-9": { family: "opus", rank: -1 },
    "sonnet-6-0": { family: "sonnet-next", rank: 0 },
  },
  tools: ["Read"],
  permission_mode: "default",
  repository: "none",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value: "provider-key", ref: { value_env: "K" } },
  },
};

import {
  LEGACY_CONFIG_TOKEN,
  storableLegacyConfig,
} from "./legacy-runtime-configs.ts";

// A claim that resumes also offers the `auto` variants of the modes a profile
// may have run converted; these tests are about the stored-mode candidates, and
// the variants have their own tests in worker-gateway.test.ts.
function withoutAuto<T extends { permission_mode?: string }>(
  configs: T[] | undefined,
): T[] | undefined {
  const kept = configs?.filter((config) => config.permission_mode !== "auto");
  return kept?.length ? kept : undefined;
}

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
  p: CatalogProfile,
  bound: Pick<WorkerBinding, "model" | "restoreProfiles"> &
    Partial<Pick<WorkerBinding, "legacyRuntimeConfigs">>,
  accepted?: string[],
) {
  const seen: ClaimInput[] = [];
  const gateway = createWorkerGateway({
    work: work({
      claimAtomic: async (input) => {
        seen.push(input);
        return {
          outcome: "claimed",
          binding: {
            sessionId: SESSION,
            attemptId: "att_1",
            leaseEpoch: 1,
            executionGeneration: 1,
            authRevision: 0,
            leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
            leaseRemainingMs: 29_950,
            profileId: "p",
            profileFingerprint: profileFingerprint(p),
            unmetered: false,
            ownerScope: "owner-a",
            repository: null,
            restore: null,
            costUsd: 0,
            providerTokens: 0,
            ...bound,
          },
        };
      },
    }),
    catalog: {
      ...withSeededInstallation({ profiles: { p }, repositories: {} }),
      ...(accepted === undefined
        ? {}
        : { runtime_versions: { accepted, current: ["0.3.270", "2.1.270"] } }),
    },
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
    const { claimed } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [],
    });
    const live = (await claimed).runtime_config;
    // What the profile removal stores: an earlier mode and model, no credential.
    return storableLegacyConfig({
      ...live,
      model: "sonnet-5-0",
      permission_mode: "bypassPermissions",
    });
  };

  test("are offered as restore configs with this claim's token and their original mode", async () => {
    const stored = await kept();
    expect(JSON.stringify(stored)).toContain(LEGACY_CONFIG_TOKEN);
    const { claimed } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [],
      legacyRuntimeConfigs: [stored],
    });
    const response = await claimed;
    const [offered] = response.restore_runtime_configs ?? [];
    expect(offered).toMatchObject({
      model: "sonnet-5-0",
      permission_mode: "bypassPermissions",
      provider: { auth: response.runtime_config.provider.auth },
    });
    expect(JSON.stringify(response)).not.toContain(LEGACY_CONFIG_TOKEN);
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  test("a rebuilt config and the same one kept are offered once", async () => {
    const stored = await kept();
    const { claimed } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [
        {
          profileId: "p",
          profileFingerprint: profileFingerprint(profile),
          model: "sonnet-5-0",
        },
      ],
      legacyRuntimeConfigs: [{ ...stored, permission_mode: "default" }],
    });
    const models = withoutAuto((await claimed).restore_runtime_configs)?.map(
      (c) => `${c.model}/${c.permission_mode}`,
    );
    expect(models).toEqual(["sonnet-5-0/default"]);
  });

  test("an entry that no longer parses, or no entry, offers nothing", async () => {
    for (const legacyRuntimeConfigs of [null, undefined, {}, [{ model: 1 }]]) {
      const { claimed } = claimWith(profile, {
        model: "sonnet-5-1",
        restoreProfiles: [],
        legacyRuntimeConfigs,
      });
      expect(
        withoutAuto((await claimed).restore_runtime_configs),
      ).toBeUndefined();
    }
  });
});

describe("a model that left the list, at claim", () => {
  test("hands the claim every removed model's one-step successor, pinned to the profile", async () => {
    const { claimed, seen } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [],
    });
    await claimed;
    const moves = seen[0]?.modelMoves ?? [];
    expect(moves.map(({ from, to }) => `${from}>${to}`)).toEqual([
      "sonnet-5-0>sonnet-5-1",
      "sonnet-5-0>sonnet-5-1",
      "opus-4-9>opus-5-0",
      "opus-4-9>opus-5-0",
    ]);
    const [v2, v1] = moves;
    expect(v2).toMatchObject({
      profileId: "p",
      fromFingerprint: profileFingerprint(profile),
      toFingerprint: profileFingerprint(profile),
    });
    expect(v1?.fromFingerprint).not.toBe(v1?.toFingerprint);
    expect(v1?.fromFingerprint).not.toBe(profileFingerprint(profile));
  });

  test("a runtime version the host still accepts has its own pins, so its sessions move too", async () => {
    const { claimed, seen } = claimWith(
      profile,
      { model: "sonnet-5-1", restoreProfiles: [] },
      ["0.3.270", "0.3.250"],
    );
    await claimed;
    const sonnet = (seen[0]?.modelMoves ?? []).filter(
      (move) => move.from === "sonnet-5-0",
    );
    expect(new Set(sonnet.map((move) => move.fromFingerprint)).size).toBe(4);
  });

  test("a profile with no family table hands over nothing, as before", async () => {
    const { model_families: _gone, ...plain } = profile;
    const { claimed, seen } = claimWith(plain, {
      model: "sonnet-5-1",
      restoreProfiles: [],
    });
    await claimed;
    expect(seen[0]?.modelMoves).toEqual([]);
  });

  test("a session moved off sonnet-5-0 still restores the checkpoint it made there", async () => {
    const { claimed } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [
        {
          profileId: "p",
          profileFingerprint: profileFingerprint(profile),
          model: "sonnet-5-0",
        },
      ],
    });
    const response = await claimed;
    expect(response.runtime_config.model).toBe("sonnet-5-1");
    expect(
      withoutAuto(response.restore_runtime_configs)?.map((c) => c.model),
    ).toEqual(["sonnet-5-0"]);
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
  });

  test("a checkpoint pinned by a version 1 fingerprint of the dropped model restores too", async () => {
    const v1 = modelMovePins(profile, []).find(
      (pin) =>
        pin.from === "sonnet-5-0" && pin.fromFingerprint !== pin.toFingerprint,
    );
    if (!v1) throw new Error("no version 1 pin");
    const { claimed } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [
        {
          profileId: "p",
          profileFingerprint: v1.fromFingerprint,
          model: null,
        },
      ],
    });
    expect(
      withoutAuto((await claimed).restore_runtime_configs)?.map((c) => c.model),
    ).toEqual(["sonnet-5-0"]);
  });

  test("a version 2 checkpoint that names no model is not taken for the dropped one", async () => {
    const { claimed } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [
        {
          profileId: "p",
          profileFingerprint: profileFingerprint(profile),
          model: null,
        },
      ],
    });
    expect(
      withoutAuto((await claimed).restore_runtime_configs),
    ).toBeUndefined();
  });

  test("a checkpoint from a model with no successor is still refused", async () => {
    const { claimed } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [
        {
          profileId: "p",
          profileFingerprint: profileFingerprint(profile),
          model: "sonnet-6-0",
        },
      ],
    });
    expect(
      withoutAuto((await claimed).restore_runtime_configs),
    ).toBeUndefined();
  });

  test("a checkpoint from another family's removed model is not accepted either", async () => {
    const { claimed } = claimWith(profile, {
      model: "sonnet-5-1",
      restoreProfiles: [
        {
          profileId: "p",
          profileFingerprint: profileFingerprint(profile),
          model: "opus-4-9",
        },
      ],
    });
    expect(
      withoutAuto((await claimed).restore_runtime_configs),
    ).toBeUndefined();
  });
});
