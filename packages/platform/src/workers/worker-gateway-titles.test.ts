import { describe, expect, test } from "bun:test";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";
import type {
  SessionTitleStore,
  TitleEgressAuthorization,
} from "../sessions/ports/session-title-store.ts";
import {
  hashTitleToken,
  type SessionTitler,
} from "../sessions/session-titler.ts";
import { testCatalog, testConnection } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const sessionId = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const scope = {
  session_id: sessionId,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};
const principal = {
  kind: "session",
  attemptId: "att_1",
  sessionId,
  leaseEpoch: 1,
  executionGeneration: 1,
  authRevision: 0,
} as const;
const catalog: SessionCatalog = testCatalog({
  connections: {
    "conn-1": testConnection({
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "provider-key",
          ref: { value_env: "K" },
        },
      },
    }),
  },
});

function notReached(): never {
  throw new Error("not reached");
}

function harness(options: {
  title?: TitleEgressAuthorization;
  work?: Partial<WorkerUnitOfWork>;
  catalog?: SessionCatalog;
  costLimitUsd?: number;
}) {
  const authorized: Uint8Array[] = [];
  const named: Array<{ sessionId: string; attemptId: string }> = [];
  const store: SessionTitleStore = {
    issueAtomic: notReached,
    async authorizeAtomic(input) {
      authorized.push(input.tokenHash);
      return options.title ?? { outcome: "invalid_token" };
    },
    settleAtomic: notReached,
  };
  const titler: SessionTitler = {
    // Never settles: finalize must not wait for it.
    afterFirstTurn(input) {
      named.push(input);
      return new Promise(() => {});
    },
  };
  const work = {
    authorizeEgressAtomic: async () => ({ outcome: "invalid_token" }),
    peekFinalizeAtomic: async () => ({ outcome: "open" }),
    ...options.work,
  } as unknown as WorkerUnitOfWork;
  const instance = createWorkerGateway({
    work,
    catalog: options.catalog ?? catalog,
    checkpoints: acceptAllCheckpoints,
    titles: { store, titler },
    options: {
      sessionCostLimitUsd: options.costLimitUsd ?? 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
    },
  });
  return { instance, authorized, named };
}

const titleGrant: TitleEgressAuthorization = {
  outcome: "ok",
  sessionId,
  attemptId: "att_first",
  connectionId: "conn-1",
  model: "claude-sonnet-5",
  costUsd: 0,
  providerTokens: 0,
};

describe("title requests on the provider route", () => {
  test("a title token gets the session connection's provider, charged to the first turn's attempt", async () => {
    const { instance, authorized } = harness({ title: titleGrant });
    const grant = await instance.authorizeEgress({
      token: "wet_title",
      purpose: "provider",
    });
    expect(authorized).toEqual([hashTitleToken("wet_title")]);
    expect(grant).toEqual({
      session_id: sessionId,
      attempt_id: "att_first",
      upstream: {
        url: "https://api.anthropic.invalid",
        headers: [["x-api-key", "provider-key"]],
      },
      // The proxy holds the title call's body to these (94S-1047).
      request_limits: {
        path: "/v1/messages",
        model: "claude-sonnet-5",
        max_tokens: 64,
      },
    });
  });

  test("any other token goes on to the attempt's own check", async () => {
    const { instance, authorized } = harness({});
    await expect(
      instance.authorizeEgress({ token: "wep_engine", purpose: "provider" }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(authorized).toEqual([]);
  });

  test("a session past its limit gets no title call", async () => {
    const { instance } = harness({
      title: { ...titleGrant, costUsd: 5 },
      costLimitUsd: 5,
    });
    await expect(
      instance.authorizeEgress({ token: "wet_title", purpose: "provider" }),
    ).rejects.toMatchObject({ status: 403, code: "BUDGET_EXCEEDED" });
  });

  test("a connection gone from the catalog is refused", async () => {
    const { instance } = harness({
      title: titleGrant,
      catalog: { connections: {}, repositories: {} },
    });
    await expect(
      instance.authorizeEgress({ token: "wet_title", purpose: "provider" }),
    ).rejects.toMatchObject({ status: 409, code: "CATALOG_MISMATCH" });
  });
});

describe("finalize and the title", () => {
  const finalized = (turnId: string, status: "completed" | "failed") => ({
    async finalizeAtomic() {
      return {
        outcome: "finalized" as const,
        result: { turnId, status, checkpointRevision: null },
      };
    },
  });
  const finalize = (
    instance: ReturnType<typeof harness>["instance"],
    turnId: string,
    status: "completed" | "failed",
  ) =>
    instance.finalize(principal, {
      ...scope,
      turn_id: turnId,
      finalize_key: "f",
      final_source_sequence: 0,
      terminal: { status, reason: null, result: null, usage: null },
      checkpoint: null,
    });

  test("a completed first turn starts the title without waiting for it", async () => {
    const { instance, named } = harness({ work: finalized("1", "completed") });
    const answer = await finalize(instance, "1", "completed");
    expect(answer.status).toBe("completed");
    expect(named).toEqual([{ sessionId, attemptId: "att_1" }]);
  });

  test("a later turn or a failed first one starts nothing", async () => {
    const later = harness({ work: finalized("2", "completed") });
    await finalize(later.instance, "2", "completed");
    expect(later.named).toEqual([]);
    const failed = harness({ work: finalized("1", "failed") });
    await finalize(failed.instance, "1", "failed");
    expect(failed.named).toEqual([]);
  });
});
