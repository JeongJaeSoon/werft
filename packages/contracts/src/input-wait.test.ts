import { describe, expect, test } from "bun:test";

import {
  createSessionRequestSchema,
  type InputWaitEventData,
  inputWaitEventDataSchema,
  MAX_PERMISSION_WAIT_SECONDS,
  pendingRequestSchema,
  postSessionAnswerResponseSchema,
  readStoredEvent,
  sessionDetailSchema,
  sessionSummarySchema,
} from "./api/index.ts";
import {
  bootstrapClaimResponseSchema,
  controlIntentSchema,
  finalizeRequestSchema,
  parkDeclinedRequestSchema,
  pendingControlRequestSchema,
  pendingControlResponseSchema,
  requestParkRequestSchema,
  TURN_INPUT_WAIT_PARKED_REASON,
} from "./worker-protocol/index.ts";

const SESSION_ID = "019a0000-0000-7000-8000-000000000102";
const RECEIPT_ID = "019a0000-0000-7000-8000-000000000101";
const AT = "2026-10-27T01:00:00Z";
const LATER = "2026-10-27T01:30:00Z";
const HASH = "a".repeat(64);

const scope = {
  session_id: SESSION_ID,
  turn_id: "1",
  attempt_id: "att_01",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 0,
};

const summary = {
  id: SESSION_ID,
  revision: 3,
  admission_state: "paused",
  status: "needs_input",
  runtime: null,
  model: null,
  repository_id: null,
  current_turn_id: null,
  queued_turn_count: 0,
  last_event_at: null,
  created_at: AT,
  updated_at: AT,
};
const detail = {
  ...summary,
  execution: null,
  checkpoint_revision: 2,
  pending_request_count: 1,
  attention: null,
  durability: {
    last_transcript_persisted_at: AT,
    checkpoint_committed_at: AT,
    checkpoint_revision: 2,
    last_completed_turn_id: null,
    last_checkpointed_turn_id: "1",
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
};
const wait = {
  state: "parked",
  since: AT,
  kinds: ["permission"],
  request_ids: ["req_1"],
  park_at: LATER,
  expires_at: LATER,
};

describe("the public wait contract", () => {
  test("detail carries the whole wait and why it paused; a list row only the stage", () => {
    expect(
      sessionDetailSchema.parse({
        ...detail,
        input_wait: wait,
        pause_reason: "awaiting_input",
      }),
    ).toMatchObject({ input_wait: wait, pause_reason: "awaiting_input" });
    expect(
      sessionSummarySchema.parse({
        ...summary,
        input_wait: { state: "parked" },
      }).input_wait,
    ).toEqual({ state: "parked" });
    // A list row never carries what it waits on.
    expect(
      sessionSummarySchema.safeParse({ ...summary, input_wait: wait }).success,
    ).toBe(false);
    for (const state of ["waiting", "parking", "parked", "expired"]) {
      expect(
        sessionDetailSchema.safeParse({
          ...detail,
          input_wait: { ...wait, state },
        }).success,
      ).toBe(true);
    }
    expect(
      sessionDetailSchema.safeParse({
        ...detail,
        input_wait: { ...wait, state: "answered" },
      }).success,
    ).toBe(false);
    expect(
      sessionDetailSchema.safeParse({ ...detail, pause_reason: "person" })
        .success,
    ).toBe(false);
    // A server older than the fields still reads.
    expect(sessionDetailSchema.safeParse(detail).success).toBe(true);
  });

  test("a pending item says its stage, when it parks and its group", () => {
    const item = {
      request_id: "req_1",
      turn_id: "2",
      attempt_id: "att_01",
      created_at: AT,
      expires_at: LATER,
      kind: "permission",
      tool: "Bash",
      input: { command: "ls" },
    };
    expect(
      pendingRequestSchema.parse({
        ...item,
        state: "parked",
        park_at: AT,
        group: "2",
      }),
    ).toMatchObject({ state: "parked", park_at: AT, group: "2" });
    expect(pendingRequestSchema.safeParse(item).success).toBe(true);
    expect(
      pendingRequestSchema.safeParse({ ...item, state: "parking" }).success,
    ).toBe(false);
  });

  test("a session may ask for its own waits, within the installation's bound", () => {
    const create = {
      agent_release_id: `sha256:${"a".repeat(64)}`,
      message: "hello",
    };
    expect(
      createSessionRequestSchema.parse({
        ...create,
        permission_wait: { park_after_seconds: 0, expire_after_seconds: 60 },
      }).permission_wait,
    ).toEqual({ park_after_seconds: 0, expire_after_seconds: 60 });
    for (const permission_wait of [
      { expire_after_seconds: 0 },
      { park_after_seconds: -1 },
      { park_after_seconds: 1.5 },
      { expire_after_seconds: MAX_PERMISSION_WAIT_SECONDS + 1 },
      { park_after_seconds: 60, extra: true },
    ]) {
      expect(
        createSessionRequestSchema.safeParse({ ...create, permission_wait })
          .success,
      ).toBe(false);
    }
  });

  test("an answer's response from before parks still reads; the new fields ride beside it", () => {
    const stored = {
      receipt_id: RECEIPT_ID,
      receipt_status: "accepted",
    } as const;
    expect(postSessionAnswerResponseSchema.parse(stored)).toEqual(stored);
    expect(
      postSessionAnswerResponseSchema.parse({
        ...stored,
        resumed: true,
        waiting_for: 0,
      }),
    ).toEqual({ ...stored, resumed: true, waiting_for: 0 });
    expect(
      postSessionAnswerResponseSchema.safeParse({ ...stored, waiting_for: -1 })
        .success,
    ).toBe(false);
  });

  test("input_wait rides the v1 system event, so any reader stores and reads it", () => {
    const data: InputWaitEventData = {
      type: "system",
      subtype: "input_wait",
      stage: "lost",
      request_ids: ["req_1"],
    };
    expect(inputWaitEventDataSchema.parse(data)).toEqual(data);
    expect(readStoredEvent("system", data)).toEqual({
      payload: { event: "system", data },
      readable: true,
    });
    for (const bad of [
      { ...data, stage: "answered" },
      { ...data, request_ids: [] },
      { ...data, message: { content: [] } },
    ]) {
      expect(inputWaitEventDataSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the worker's park contract", () => {
  test("a park is a third control kind", () => {
    const control = {
      control_id: RECEIPT_ID,
      kind: "park",
      target_turn_id: null,
      issued_at: AT,
    } as const;
    expect(
      pendingControlResponseSchema.parse({ control, answers: [] }).control,
    ).toEqual(control);
    expect(
      controlIntentSchema.safeParse({ ...control, kind: "park_now" }).success,
    ).toBe(false);
  });

  test("a worker declines a park for a reason, or asks for one on its turn", () => {
    expect(
      parkDeclinedRequestSchema.safeParse({
        ...scope,
        pause_control_id: RECEIPT_ID,
        reason: "checkpoint_unavailable",
      }).success,
    ).toBe(true);
    expect(
      parkDeclinedRequestSchema.safeParse({
        ...scope,
        pause_control_id: RECEIPT_ID,
        reason: "changed_mind",
      }).success,
    ).toBe(false);
    expect(requestParkRequestSchema.safeParse(scope).success).toBe(true);
    expect(
      requestParkRequestSchema.safeParse({ ...scope, turn_id: null }).success,
    ).toBe(false);
  });

  test("a turn parked on its requests is interrupted with a checkpoint", () => {
    const finalize = {
      ...scope,
      finalize_key: "fin_1",
      final_source_sequence: 4,
      terminal: {
        status: "interrupted",
        reason: TURN_INPUT_WAIT_PARKED_REASON,
        result: null,
        usage: null,
      },
      checkpoint: {
        revision: 3,
        manifest_ref: "m/3",
        manifest_sha256: HASH,
      },
    };
    expect(finalizeRequestSchema.safeParse(finalize).success).toBe(true);
    expect(
      finalizeRequestSchema.safeParse({ ...finalize, checkpoint: null })
        .success,
    ).toBe(false);
    expect(
      finalizeRequestSchema.safeParse({
        ...finalize,
        terminal: { ...finalize.terminal, status: "completed" },
      }).success,
    ).toBe(false);
  });

  test("a resumed turn's grants and delivery reports ride optional fields", () => {
    const claim = {
      ...scope,
      turn_id: null,
      session_credential: "cred",
      lease_expires_at: AT,
      lease_remaining_ms: 1_000,
      runtime: {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        connection_id: "fake-messages",
      },
      spec_digest: `sha256:${HASH}`,
      runtime_config: {
        model: "claude-sonnet-5",
        tools: [],
        permission_mode: "default",
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.invalid",
          auth: { kind: "egress_token", token: "egress" },
        },
      },
      workspace: { repository: null },
      object_store: { access: { kind: "egress_token", token: "store" } },
      principal: { owner_scope: "owner" },
      restore: null,
      remaining_budget_usd: null,
    };
    const grant = {
      request_id: "req_1",
      turn_id: "3",
      tool: "Bash",
      input_hash: HASH,
    };
    expect(
      bootstrapClaimResponseSchema.parse({ ...claim, grants: [grant] }).grants,
    ).toEqual([grant]);
    expect(bootstrapClaimResponseSchema.safeParse(claim).success).toBe(true);
    // A worker built before the field reads a claim that carries it: the
    // response object is not strict, so the grant is dropped, not refused.
    const before = bootstrapClaimResponseSchema.omit({ grants: true });
    expect(before.safeParse({ ...claim, grants: [grant] }).success).toBe(true);

    const poll = { ...scope, answers_after: 0 };
    expect(pendingControlRequestSchema.safeParse(poll).success).toBe(true);
    expect(
      pendingControlRequestSchema.safeParse({
        ...poll,
        delivered: [{ request_id: "req_1", outcome: "grant_unused" }],
      }).success,
    ).toBe(true);
    expect(
      pendingControlRequestSchema.safeParse({ ...poll, delivered: [] }).success,
    ).toBe(false);
  });
});
