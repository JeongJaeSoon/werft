import { describe, expect, test } from "bun:test";
import {
  type AuthorizationRequest,
  type AuthorizationSubject,
  bootstrapClaimResponseSchema,
  type PostSessionAnswerRequest,
  pendingControlResponseSchema,
  type WorkerCapabilities,
} from "@werft-ai/contracts";
import { z } from "zod";
import {
  type AuthorizationPolicy,
  AuthorizationUndecidedError,
} from "../access-control/index.ts";
import type { WorkerUnitOfWork } from "../ports/worker-unit-of-work.ts";
import type { WorkerPendingStore } from "../sessions/ports/pending-requests.ts";
import { testBinding, testCatalog } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
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

const BOUND = { approval_remember: true, session_allow_check: true } as const;

// A stored giver for a faked policy: only its shape and channel matter here.
// The real policy judges a taken-over giver through this gateway in
// policy-private-channel-writes.test.ts, as a web member.
const SLACK_SUBJECT: AuthorizationSubject = {
  principal: {
    kind: "user",
    id: "11111111-1111-4111-8111-111111111111",
    workspace_id: "22222222-2222-4222-8222-222222222222",
    role: "member",
    scopes: ["sessions:approve"],
  },
  actor_user_id: "11111111-1111-4111-8111-111111111111",
  surface: {
    kind: "slack",
    agent_id: "33333333-3333-4333-8333-333333333333",
    channel_id: "C0PRIVATE",
  },
};

function wired(
  options: {
    grant?: { ownerScope: string; subject: unknown } | null;
    outcome?: "allow" | "deny";
    /** Thrown by the policy instead of a decision. */
    failure?: Error;
    authorization?: false;
    /** What the store reads once the policy has answered. */
    after?: "lease_expired" | null;
  } = {},
) {
  const stored: PostSessionAnswerRequest = {
    request_id: "req_1",
    kind: "permission",
    decision: "allow",
    remember: "session",
  };
  const asked: AuthorizationRequest[] = [];
  const authorization = {
    async authorize(request: AuthorizationRequest) {
      asked.push(request);
      if (options.failure !== undefined) throw options.failure;
      return {
        outcome: options.outcome ?? "allow",
        reason_code: options.outcome === "deny" ? "not_found" : "ok",
        effective_scopes: [],
        policy_version: "test",
        decision_id: "44444444-4444-4444-8444-444444444444",
      };
    },
  } as unknown as AuthorizationPolicy;
  const pending = {
    hasUndelivered: async () => false,
    sessionAllowAtomic: async () => {
      if (asked.length > 0 && options.after === "lease_expired") {
        return { outcome: "lease_expired" };
      }
      if (asked.length > 0 && options.after === null) {
        return { outcome: "ok", grant: null };
      }
      return {
        outcome: "ok",
        grant:
          options.grant === undefined
            ? { ownerScope: "owner-a", subject: SLACK_SUBJECT }
            : options.grant,
      };
    },
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
    ...(options.authorization === false ? {} : { authorization }),
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 30_000,
    },
  });
  const claim = (capabilities?: WorkerCapabilities) =>
    gateway.bootstrapClaim(
      { kind: "bootstrap" },
      {
        ...(capabilities === undefined ? {} : { capabilities }),
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      },
    );
  const poll = (capabilities?: WorkerCapabilities) =>
    gateway.pendingControl(principal, {
      ...scope,
      ...(capabilities === undefined ? {} : { capabilities }),
      answers_after: 0,
    });
  const check = () =>
    gateway.sessionAllow(principal, {
      ...scope,
      turn_id: "1",
      grant_request_id: "req_1",
      tool_call_id: "toolu_2",
      input_hash: HASH,
    });
  return { claim, poll, check, asked };
}

describe("an answer remembered for the session, across worker versions", () => {
  test("a poll that announces session_allow_check gets the answer as stored", async () => {
    const response = await wired().poll(BOUND);
    expect(
      pendingControlResponseSchema.parse(response).answers[0],
    ).toMatchObject({ answer: { decision: "allow", remember: "session" } });
  });

  test("a poller with approval_remember alone gets the plain allow: its engine would keep the rule for anyone", async () => {
    const response = await wired().poll({ approval_remember: true });
    expect(response.answers[0]?.answer).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "allow",
    });
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
    const response = await wired().poll(BOUND);
    expect(oldAnswers.safeParse(response).success).toBe(false);
  });

  test("answer_surface reaches only a poller that announced it", async () => {
    const announced = pendingControlResponseSchema.parse(
      await wired().poll({ answer_surface: true }),
    );
    expect(announced.answers[0]?.answer_surface).toBe("slack");

    for (const response of [await wired().poll(), await wired().poll(BOUND)]) {
      expect(response.answers[0]).not.toHaveProperty("answer_surface");
    }
  });

  test("a claim that announces it carries the rules a parked allow keeps", async () => {
    const claimed = bootstrapClaimResponseSchema.parse(
      await wired().claim(BOUND),
    );
    expect(claimed.grants?.map((grant) => grant.remember_offer)).toEqual([
      OFFER,
      undefined,
    ]);
  });

  test("a claim with approval_remember alone carries no rules", async () => {
    const claimed = await wired().claim({ approval_remember: true });
    expect(claimed.grants?.every((g) => !("remember_offer" in g))).toBe(true);
  });

  test("an older claimer gets grants its strict parser takes", async () => {
    const claimed = await wired().claim();
    expect(claimed.grants?.every((g) => !("remember_offer" in g))).toBe(true);
    for (const grant of claimed.grants ?? []) {
      expect(oldGrant.safeParse(grant).success).toBe(true);
    }
  });
});

describe("a session allow judged again before a call it covers", () => {
  test("the giver is judged on session.approve for the request they answered, without their click's channel", async () => {
    const { check, asked } = wired();
    expect(await check()).toEqual({ allowed: true });
    expect(asked).toHaveLength(1);
    const { surface, ...rest } = SLACK_SUBJECT;
    const { channel_id: _channel, ...unclicked } = surface;
    expect(asked[0]).toEqual({
      subject: { ...rest, surface: unclicked },
      action: "session.approve",
      resource: {
        kind: "session",
        id: SESSION,
        owner_scope: "owner-a",
        pending_request_id: "req_1",
      },
      request_id: "toolu_2",
    });
  });

  test("a giver who no longer passes ends the allow", async () => {
    expect(await wired({ outcome: "deny" }).check()).toEqual({
      allowed: false,
    });
  });

  test("a request that is no session allow with its giver on record stands for nothing", async () => {
    const { check, asked } = wired({ grant: null });
    expect(await check()).toEqual({ allowed: false });
    expect(asked).toHaveLength(0);
  });

  test("a stored subject that no longer parses stands for nothing", async () => {
    const { check, asked } = wired({
      grant: { ownerScope: "owner-a", subject: { principal: "someone" } },
    });
    expect(await check()).toEqual({ allowed: false });
    expect(asked).toHaveLength(0);
  });

  test("a lease lost while the policy was asked is refused, not allowed", async () => {
    await expect(
      wired({ after: "lease_expired" }).check(),
    ).rejects.toMatchObject({
      code: "LEASE_EXPIRED",
    });
  });

  test("an allow gone by the time the policy answers stands for nothing", async () => {
    const { check, asked } = wired({ after: null });
    expect(await check()).toEqual({ allowed: false });
    expect(asked).toHaveLength(1);
  });

  test("a policy that could not read its store is a retryable 503, never an allow", async () => {
    const { check, asked } = wired({
      failure: new AuthorizationUndecidedError(new Error("down")),
    });
    await expect(check()).rejects.toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    expect(asked).toHaveLength(1);
  });

  test("any other policy failure is not turned into a retry", async () => {
    const failure = new Error("boom");
    await expect(wired({ failure }).check()).rejects.toBe(failure);
  });

  test("a gateway with no policy allows nothing", async () => {
    expect(await wired({ authorization: false }).check()).toEqual({
      allowed: false,
    });
  });
});
