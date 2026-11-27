import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  runtimeConfigSchema,
} from "@werft-ai/contracts";
import { unpackBundleTar } from "@werft-ai/runtime-core";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import {
  BundleIntegrityError,
  createExtensionBundleService,
} from "../extensions/bundle-service.ts";
import { validateExtensionBundle } from "../extensions/bundle-validator.ts";
import type {
  ExtensionBundle,
  ExtensionBundleStore,
} from "../extensions/ports/extension-bundle-store.ts";
import type {
  ExtensionsStateResult,
  WorkerBinding,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { WorkerPendingStore } from "../sessions/ports/pending-requests.ts";
import { testBinding, testCatalog } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import {
  createWorkerGateway,
  type WorkerGatewayError,
} from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const OWNER = "019a0000-0000-7000-8000-0000000000f1";
const LINT = { name: "lint", digest: "ab".repeat(32), scope: "agent" } as const;
const DOCS = {
  name: "docs",
  digest: "cd".repeat(32),
  scope: "workspace",
} as const;

const catalog = testCatalog();

const principal = {
  kind: "session",
  attemptId: "att_1",
  sessionId: SESSION,
  leaseEpoch: 1,
  executionGeneration: 1,
  authRevision: 0,
} as const;

function bindingWith(extensions?: WorkerBinding["extensions"]): WorkerBinding {
  return testBinding({
    sessionId: SESSION,
    ownerScope: OWNER,
    ...(extensions === undefined ? {} : { extensions }),
  });
}

function gatewayOver(
  methods: Partial<WorkerUnitOfWork>,
  extensions?: {
    archive(workspaceId: string, digest: string): Promise<Uint8Array | null>;
  },
) {
  const work = new Proxy(methods, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      return () => {
        throw new Error(`not reached: ${String(key)}`);
      };
    },
  }) as unknown as WorkerUnitOfWork;
  return createWorkerGateway({
    work,
    catalog,
    pending: {} as unknown as WorkerPendingStore,
    checkpoints: acceptAllCheckpoints,
    ...(extensions === undefined ? {} : { extensions }),
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 30_000,
      now: () => new Date("2026-09-22T00:00:00Z"),
    },
  });
}

function claim(binding: WorkerBinding) {
  return gatewayOver({
    claimAtomic: async () => ({ outcome: "claimed", binding }),
  }).bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: "e",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "n" },
    },
  );
}

const olderRuntimeConfig = runtimeConfigSchema.omit({ extensions: true });

describe("the claim carries the bundles the session row pinned", () => {
  test("a session with none claims without the field, and an older worker's schema parses it", async () => {
    for (const none of [undefined, [], null]) {
      const response = await claim(bindingWith(none));
      expect(Object.keys(response.runtime_config)).not.toContain("extensions");
      expect(
        olderRuntimeConfig.safeParse(response.runtime_config).success,
      ).toBe(true);
      expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(
        true,
      );
    }
  });

  test("the pinned bundles ride in runtime_config by name, digest and scope only", async () => {
    const response = await claim(
      bindingWith([
        { bundle_id: "019a0000-0000-7000-8000-0000000e0001", ...LINT },
        { bundle_id: "019a0000-0000-7000-8000-0000000e0002", ...DOCS },
      ]),
    );
    expect(response.runtime_config.extensions).toEqual([LINT, DOCS]);
    expect(JSON.stringify(response)).not.toContain("0000000e0001");
    expect(bootstrapClaimResponseSchema.safeParse(response).success).toBe(true);
    expect(olderRuntimeConfig.safeParse(response.runtime_config).success).toBe(
      false,
    );
  });

  test("the configs earlier checkpoints are accepted under carry the same bundles", async () => {
    const current = await claim(bindingWith());
    const withHistory = {
      ...bindingWith([
        { bundle_id: "019a0000-0000-7000-8000-0000000e0001", ...LINT },
      ]),
      legacyRuntimeConfigs: [
        { ...current.runtime_config, model: "claude-sonnet-4" },
      ],
    };
    const response = await claim(withHistory);
    const alternates = response.restore_runtime_configs ?? [];
    expect(alternates.length).toBeGreaterThan(0);
    for (const config of alternates) expect(config.extensions).toEqual([LINT]);
  });

  test("a second claim of the same row names the same list, whatever the workspace holds now", async () => {
    const pinned = bindingWith([
      { bundle_id: "019a0000-0000-7000-8000-0000000e0001", ...LINT },
    ]);
    const first = await claim(pinned);
    const again = await claim(pinned);
    expect(again.runtime_config.extensions).toEqual(
      first.runtime_config.extensions,
    );
  });

  test("the spec digest does not move with the bundles", async () => {
    const without = await claim(bindingWith());
    const withOne = await claim(
      bindingWith([
        { bundle_id: "019a0000-0000-7000-8000-0000000e0001", ...LINT },
      ]),
    );
    expect(withOne.spec_digest).toBe(without.spec_digest);
    expect(withOne.spec_digest).toBe(bindingWith().specDigest);
  });
});

describe("the extension bundle route", () => {
  const stateOk = (
    extensions: readonly (typeof LINT | typeof DOCS)[],
  ): ExtensionsStateResult => ({
    outcome: "ok",
    ownerScope: OWNER,
    extensions: extensions.map((e) => ({
      bundle_id: "019a0000-0000-7000-8000-0000000e0001",
      ...e,
    })),
  });
  const bytes = new Uint8Array([1, 2, 3]);

  function route(
    state: ExtensionsStateResult,
    archive: (w: string, d: string) => Promise<Uint8Array | null> = async () =>
      bytes,
  ) {
    const asked: { fence: unknown; archive: [string, string][] } = {
      fence: null,
      archive: [],
    };
    const gateway = gatewayOver(
      {
        extensionsStateAtomic: async (input) => {
          asked.fence = input.fence;
          return state;
        },
      },
      {
        archive: async (workspaceId, digest) => {
          asked.archive.push([workspaceId, digest]);
          return archive(workspaceId, digest);
        },
      },
    );
    return { gateway, asked };
  }

  async function refusal(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error as WorkerGatewayError;
    }
    throw new Error("expected a refusal");
  }

  test("serves a pinned digest to the attempt that holds the session, from the session's own partition", async () => {
    const { gateway, asked } = route(stateOk([LINT]));
    const served = await gateway.extensionBundle(principal, {
      attemptId: "att_1",
      digest: LINT.digest,
    });
    expect(served).toEqual({ digest: LINT.digest, tar: bytes });
    expect(asked.fence).toEqual({
      sessionId: SESSION,
      attemptId: "att_1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 0,
    });
    expect(asked.archive).toEqual([[OWNER, LINT.digest]]);
  });

  test("a digest the row did not pin is refused, and the store is never asked", async () => {
    const { gateway, asked } = route(stateOk([LINT]));
    const error = await refusal(
      gateway.extensionBundle(principal, {
        attemptId: "att_1",
        digest: DOCS.digest,
      }),
    );
    expect(error.status).toBe(404);
    expect(asked.archive).toEqual([]);
  });

  test("another attempt's path, a launch nonce and a missing store are refused", async () => {
    const { gateway, asked } = route(stateOk([LINT]));
    const other = await refusal(
      gateway.extensionBundle(principal, {
        attemptId: "att_2",
        digest: LINT.digest,
      }),
    );
    expect(other.status).toBe(403);
    const nonce = await refusal(
      gateway.extensionBundle(
        { kind: "bootstrap" },
        { attemptId: "att_1", digest: LINT.digest },
      ),
    );
    expect(nonce.status).toBe(403);
    expect(asked.fence).toBeNull();
    const bare = gatewayOver({
      extensionsStateAtomic: async () => stateOk([]),
    });
    const missing = await refusal(
      bare.extensionBundle(principal, {
        attemptId: "att_1",
        digest: LINT.digest,
      }),
    );
    expect(missing.status).toBe(404);
  });

  test("an attempt that lost the lease or the epoch is refused", async () => {
    for (const outcome of ["lease_expired", "stale_epoch"] as const) {
      const { gateway, asked } = route({ outcome });
      const error = await refusal(
        gateway.extensionBundle(principal, {
          attemptId: "att_1",
          digest: LINT.digest,
        }),
      );
      expect(error.status).toBe(409);
      expect(asked.archive).toEqual([]);
    }
  });

  test("a stored object that fails its check is never served; a bundle nobody stored is a 404", async () => {
    const damaged = route(stateOk([LINT]), async () => {
      throw new BundleIntegrityError("damaged");
    });
    const failed = await refusal(
      damaged.gateway.extensionBundle(principal, {
        attemptId: "att_1",
        digest: LINT.digest,
      }),
    );
    expect(failed.status).toBe(409);
    expect(failed.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(failed.retryable).toBe(false);
    expect(failed.message).not.toContain("damaged");
    expect(failed.message).toContain("integrity check");
    const gone = route(stateOk([LINT]), async () => null);
    const missing = await refusal(
      gone.gateway.extensionBundle(principal, {
        attemptId: "att_1",
        digest: LINT.digest,
      }),
    );
    expect(missing.status).toBe(404);
  });
});

describe("a pinned skill whose upload had a block scalar description", () => {
  const SKILL =
    "---\nname: research\ndescription: |-\n  Use for research.\n  Second line.\n---\nDo it.\n";

  /** The real service over an in-memory store: what start and resume read. */
  async function registered() {
    const rows: ExtensionBundle[] = [];
    const store = {
      async findByDigest(workspaceId: string, digest: string) {
        return (
          rows.find(
            (r) => r.workspaceId === workspaceId && r.digest === digest,
          ) ?? null
        );
      },
      async mayManage() {
        return "ok" as const;
      },
      async register(input: Parameters<ExtensionBundleStore["register"]>[0]) {
        const bundle = {
          id: input.id,
          workspaceId: input.workspaceId,
          name: input.name,
          digest: input.digest,
        } as ExtensionBundle;
        rows.push(bundle);
        return {
          outcome: "registered" as const,
          bundle,
          receiptId: input.receiptId,
        };
      },
    } as unknown as ExtensionBundleStore;
    const service = createExtensionBundleService({
      store,
      objects: createMemoryCheckpointObjectStore(),
    });
    const result = await service.register({
      principal: { ownerId: OWNER },
      slug: "research",
      files: [
        {
          path: "skills/research/SKILL.md",
          kind: "file",
          mode: 0o644,
          bytes: new TextEncoder().encode(SKILL),
        },
      ],
      label: "research",
      source: "upload",
      skill: true,
    });
    if (result.outcome !== "registered") throw new Error(result.outcome);
    return { service, digest: result.bundle.digest };
  }

  test("the start and a resumed attempt are both served the pinned tree, which reads back to its digest", async () => {
    const { service, digest } = await registered();
    const pinned = { name: "research", digest, scope: "agent" } as const;
    const gateway = gatewayOver(
      {
        extensionsStateAtomic: async () => ({
          outcome: "ok",
          ownerScope: OWNER,
          extensions: [
            { bundle_id: "019a0000-0000-7000-8000-0000000e0001", ...pinned },
          ],
        }),
      },
      service,
    );
    const start = principal;
    const resumed = { ...principal, attemptId: "att_2", leaseEpoch: 2 };
    for (const holder of [start, resumed]) {
      const served = await gateway.extensionBundle(holder, {
        attemptId: holder.attemptId,
        digest,
      });
      expect(served.digest).toBe(digest);
      // What the worker checks before it publishes the tree for the engine.
      const again = validateExtensionBundle({
        slug: "research",
        files: unpackBundleTar(served.tar),
      });
      if (!again.ok) throw new Error(JSON.stringify(again.issues));
      expect(again.bundle.digest).toBe(digest);
      const skill = again.bundle.files.find(
        (f) => f.path === "skills/research/SKILL.md",
      );
      expect(new TextDecoder().decode(skill?.bytes)).toBe(
        '---\nname: "research"\ndescription: "Use for research.\\nSecond line."\n---\nDo it.\n',
      );
    }
  });
});
