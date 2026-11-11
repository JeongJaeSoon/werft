import { describe, expect, test } from "bun:test";
import {
  bootstrapClaimResponseSchema,
  type PostSessionAnswerRequest,
  pendingControlResponseSchema,
} from "@werft-ai/contracts";
import { z } from "zod";

import { acceptAllCheckpoints } from "../checkpoints/ports/checkpoint-verifier.ts";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import type { WorkerPendingStore } from "../sessions/ports/pending-requests.ts";
import { testBinding, testCatalog } from "../testing/catalog-fakes.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const HASH = "a".repeat(64);
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
const catalog = testCatalog();

const OFFER = [{ tool_name: "Read" }];

// The schemas of a worker image from before `remember`: every object strict,
// as they were. A field they do not know refuses the whole message.
const oldAnswers = z.object({
  answers: z.array(
    z
      .object({
        sequence: z.number(),
        input_hash: z.string(),
        answer: z
          .object({
            request_id: z.string(),
            kind: z.literal("permission"),
            decision: z.enum(["allow", "deny"]),
            reason: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
  ),
});
const oldGrant = z
  .object({
    request_id: z.string(),
    turn_id: z.string(),
    tool: z.string(),
    input_hash: z.string(),
  })
  .strict();

function wired() {
  const stored: PostSessionAnswerRequest = {
    request_id: "req_1",
    kind: "permission",
    decision: "allow",
    remember: "session",
  };
  const pending = {
    hasUndelivered: async () => false,
    pendingControlAtomic: async () => ({
      outcome: "ok",
      control: null,
      answers: [
        {
          sequence: 1,
          answer: stored,
          inputHash: HASH,
          answerSurface: "slack",
        },
      ],
    }),
  } as unknown as WorkerPendingStore;
  const binding = testBinding({
    sessionId: SESSION,
    attemptId: "att_1",
    costUsd: 0,
    providerTokens: 0,
    repository: null,
    leaseEpoch: 1,
    executionGeneration: 1,
    authRevision: 0,
    leaseExpiresAt: new Date("2026-09-22T00:00:30Z"),
    leaseRemainingMs: 29_950,
    unmetered: false,
    ownerScope: "owner-a",
    restore: null,
    grants: [
      {
        request_id: "req_parked",
        turn_id: "1",
        tool: "Read",
        input_hash: HASH,
        remember_offer: OFFER,
      },
      { request_id: "req_plain", turn_id: "1", tool: "Read", input_hash: HASH },
    ],
  });
  const work = new Proxy(
    { claimAtomic: async () => ({ outcome: "claimed", binding }) },
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
    pending,
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
    },
  });
  const claim = (capabilities?: { approval_remember: true }) =>
    gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        ...(capabilities === undefined ? {} : { capabilities }),
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      },
    );
  const poll = (
    capabilities?: { approval_remember: true } | { answer_surface: true },
  ) =>
    gateway.pendingControl(principal, {
      ...scope,
      ...(capabilities === undefined ? {} : { capabilities }),
      answers_after: 0,
    });
  return { claim, poll };
}

describe("an answer remembered for the session, across worker versions", () => {
  test("a poll that announces approval_remember gets the answer as stored", async () => {
    const response = await wired().poll({ approval_remember: true });
    expect(
      pendingControlResponseSchema.parse(response).answers[0],
    ).toMatchObject({ answer: { decision: "allow", remember: "session" } });
  });

  test("an older poller gets the plain allow, which its strict parser takes", async () => {
    const response = await wired().poll();
    expect(response.answers[0]?.answer).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "allow",
    });
    expect(oldAnswers.safeParse(response).success).toBe(true);
  });

  test("the same response with remember is what the older parser refuses", async () => {
    const response = await wired().poll({ approval_remember: true });
    expect(oldAnswers.safeParse(response).success).toBe(false);
  });

  test("answer_surface reaches only a poller that announced it", async () => {
    const announced = pendingControlResponseSchema.parse(
      await wired().poll({ answer_surface: true }),
    );
    expect(announced.answers[0]?.answer_surface).toBe("slack");

    for (const response of [
      await wired().poll(),
      await wired().poll({ approval_remember: true }),
    ]) {
      expect(response.answers[0]).not.toHaveProperty("answer_surface");
    }
  });

  test("a claim that announces it carries the rules a parked allow keeps", async () => {
    const claimed = bootstrapClaimResponseSchema.parse(
      await wired().claim({ approval_remember: true }),
    );
    expect(claimed.grants?.map((grant) => grant.remember_offer)).toEqual([
      OFFER,
      undefined,
    ]);
  });

  test("an older claimer gets grants its strict parser takes", async () => {
    const claimed = await wired().claim();
    expect(claimed.grants?.every((g) => !("remember_offer" in g))).toBe(true);
    for (const grant of claimed.grants ?? []) {
      expect(oldGrant.safeParse(grant).success).toBe(true);
    }
  });
});
