import { describe, expect, test } from "bun:test";

import {
  ADMISSION_STATE_VALUES,
  API_ERROR_CODE_VALUES,
  apiErrorResponseSchema,
  appendEventsRequestSchema,
  bootstrapClaimRequestSchema,
  bootstrapClaimResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  finalizeRequestSchema,
  finalizeResponseSchema,
  getSessionResponseSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  listSessionsQuerySchema,
  nextInputRequestSchema,
  opaqueCursorSchema,
  pendingControlRequestSchema,
  pendingControlResponseSchema,
  pendingRequestSchema,
  postSessionAnswerRequestSchema,
  postSessionMessageRequestSchema,
  RECEIPT_STATUS_VALUES,
  receiptSchema,
  recoveryDecisionRequestSchema,
  releaseRequestSchema,
  restorePlanResponseSchema,
  SESSION_EVENT_NAMES,
  SESSION_STATUS_VALUES,
  sessionEventSchema,
  sessionMessageSchema,
  sessionStatusSchema,
  sessionSummarySchema,
  sseEventSchema,
  TURN_STATUS_VALUES,
  unassignedSessionSignalSchema,
  workerScopeSchema,
} from "./index.ts";

const SESSION_ID = "019a0000-0000-7000-8000-000000000001";
const RECEIPT_ID = "019a0000-0000-7000-8000-000000000002";
const AT = "2026-09-18T01:00:00Z";

describe("session contracts", () => {
  test("keeps the status projection and admission vocabularies separate", () => {
    expect(SESSION_STATUS_VALUES).toEqual([
      "queued",
      "running",
      "needs_input",
      "idle",
      "failed",
      "stopped",
    ]);
    expect(ADMISSION_STATE_VALUES).toEqual([
      "active",
      "pausing",
      "paused",
      "resuming",
      "stopping",
      "stopped",
      "recovery_required",
      "closing",
      "closed",
    ]);
    expect(TURN_STATUS_VALUES).toContain("outcome_unknown");
    expect(TURN_STATUS_VALUES).not.toContain("done");
    expect(sessionStatusSchema.safeParse("complete").success).toBe(false);
  });

  test("accepts the api.md create example and rejects the legacy shape", () => {
    expect(
      createSessionRequestSchema.safeParse({
        agent_release_id: `sha256:${"a".repeat(64)}`,
        repository_id: "sample-app",
        message: "Inspect the failing unit test and propose a fix.",
      }).success,
    ).toBe(true);
    // A session always runs an agent release.
    expect(
      createSessionRequestSchema.safeParse({
        repository_id: "sample-app",
        message: "Inspect the failing unit test and propose a fix.",
      }).success,
    ).toBe(false);
    expect(
      createSessionRequestSchema.safeParse({
        repo_url: "https://github.com/acme/example.git",
        base_branch: "main",
        message: "Implement the health check.",
      }).success,
    ).toBe(false);
    expect(
      createSessionResponseSchema.safeParse({
        session_id: SESSION_ID,
        turn_id: "1",
        receipt_id: RECEIPT_ID,
        receipt_status: "accepted",
        status: "queued",
      }).success,
    ).toBe(true);
  });

  test("summary repository_id is a catalog key or null, never empty", () => {
    const summary = {
      id: SESSION_ID,
      title: null,
      revision: 0,
      admission_state: "active",
      status: "queued",
      runtime: null,
      model: null,
      repository_id: null,
      current_turn_id: null,
      queued_turn_count: 0,
      last_event_at: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(sessionSummarySchema.parse(summary).repository_id).toBeNull();
    expect(
      sessionSummarySchema.safeParse({ ...summary, repository_id: "" }).success,
    ).toBe(false);
    const { repository_id: _omitted, ...missing } = summary;
    expect(sessionSummarySchema.safeParse(missing).success).toBe(false);
  });

  test("summary repository names a branch, and is null when absent", () => {
    const summary = {
      id: SESSION_ID,
      title: null,
      revision: 0,
      admission_state: "active",
      status: "queued",
      runtime: null,
      model: null,
      repository_id: null,
      current_turn_id: null,
      queued_turn_count: 0,
      last_event_at: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(sessionSummarySchema.parse(summary).repository).toBeNull();
    const legacy = { id: null, full_name: null, branch: "main" };
    expect(
      sessionSummarySchema.parse({ ...summary, repository: legacy }).repository,
    ).toEqual(legacy);
    for (const repository of [
      { ...legacy, branch: null },
      { ...legacy, branch: "" },
      { ...legacy, full_name: "" },
      { ...legacy, id: "" },
    ]) {
      expect(
        sessionSummarySchema.safeParse({ ...summary, repository }).success,
      ).toBe(false);
    }
  });

  test("summary attached_repositories is absent when unconfirmed and [] when none", () => {
    const summary = {
      id: SESSION_ID,
      title: null,
      revision: 0,
      admission_state: "active",
      status: "queued",
      runtime: null,
      model: null,
      repository_id: null,
      current_turn_id: null,
      queued_turn_count: 0,
      last_event_at: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(
      sessionSummarySchema.parse(summary).attached_repositories,
    ).toBeUndefined();
    expect(
      sessionSummarySchema.parse({ ...summary, attached_repositories: [] })
        .attached_repositories,
    ).toEqual([]);
    const named = [
      { id: "a", full_name: "acme/a" },
      { id: "b", full_name: null },
    ];
    expect(
      sessionSummarySchema.parse({ ...summary, attached_repositories: named })
        .attached_repositories,
    ).toEqual(named);
    for (const attached_repositories of [
      [{ id: "", full_name: "acme/a" }],
      [{ id: "a", full_name: "" }],
      [{ id: "a" }],
      null,
    ]) {
      expect(
        sessionSummarySchema.safeParse({ ...summary, attached_repositories })
          .success,
      ).toBe(false);
    }
  });

  test("a summary from a server before titles reads title null", () => {
    const { title: _omitted, ...older } = {
      id: SESSION_ID,
      title: "x",
      revision: 0,
      admission_state: "active",
      status: "queued",
      runtime: null,
      model: null,
      repository_id: null,
      current_turn_id: null,
      queued_turn_count: 0,
      last_event_at: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(sessionSummarySchema.parse(older).title).toBeNull();
    expect(
      sessionSummarySchema.safeParse({ ...older, title: "" }).success,
    ).toBe(false);
  });

  test("summary runtime is a whole catalog entry or null, never a partial one", () => {
    const summary = {
      id: SESSION_ID,
      title: null,
      revision: 0,
      admission_state: "active",
      status: "queued",
      runtime: null,
      model: null,
      repository_id: null,
      current_turn_id: null,
      queued_turn_count: 0,
      last_event_at: null,
      created_at: AT,
      updated_at: AT,
    };
    expect(sessionSummarySchema.parse(summary).runtime).toBeNull();
    const runtime = {
      kind: "claude_agent_sdk",
      version: "0.3.270",
      connection_id: "fake-messages",
      model: "claude-sonnet-5",
      permission_mode: "bypassPermissions",
    } as const;
    expect(sessionSummarySchema.parse({ ...summary, runtime }).runtime).toEqual(
      runtime,
    );
    for (const partial of [
      { ...runtime, connection_id: null },
      { ...runtime, version: null },
      { ...runtime, model: null },
      { ...runtime, permission_mode: "yolo" },
    ]) {
      expect(
        sessionSummarySchema.safeParse({ ...summary, runtime: partial })
          .success,
      ).toBe(false);
    }
    const { runtime: _omitted, ...missing } = summary;
    expect(sessionSummarySchema.safeParse(missing).success).toBe(false);
  });

  test("accepts the api.md detail example with durability", () => {
    const detail = getSessionResponseSchema.parse({
      id: SESSION_ID,
      title: null,
      revision: 12,
      admission_state: "active",
      status: "needs_input",
      runtime: {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        connection_id: "fake-messages",
        model: "claude-sonnet-5",
        permission_mode: "default",
      },
      model: "claude-sonnet-5",
      repository_id: "sample-app",
      current_turn_id: "1",
      queued_turn_count: 1,
      last_event_at: AT,
      execution: { backend: "local_docker", state: "running", observed_at: AT },
      checkpoint_revision: 3,
      pending_request_count: 1,
      attention: null,
      durability: {
        last_transcript_persisted_at: null,
        checkpoint_committed_at: null,
        checkpoint_revision: null,
        last_completed_turn_id: null,
        last_checkpointed_turn_id: null,
        checkpoint_pending_reason: null,
        checkpoint_fallback_revision: null,
        context_reset_turn_id: null,
      },
      created_at: AT,
      updated_at: AT,
    });
    expect(detail.execution?.backend).toBe("local_docker");
    expect(
      listSessionsQuerySchema.parse({ status: "idle", limit: "20" }),
    ).toEqual({ status: "idle", limit: 20 });
    expect(listSessionsQuerySchema.parse({}).limit).toBe(50);
    expect(listSessionsQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
  });

  test("keeps the queue message payload and the empty assignment signal", () => {
    expect(sessionMessageSchema.parse({ message: "Continue." })).toEqual({
      message: "Continue.",
    });
    expect(
      postSessionMessageRequestSchema.parse({ message: "Apply the fix." }),
    ).toEqual({ message: "Apply the fix.", mode: "enqueue" });
    expect(
      postSessionMessageRequestSchema.safeParse({
        message: "x",
        mode: "steer",
      }).success,
    ).toBe(false);
    // 32 KiB is a byte limit: 12k Hangul characters are 36 KB of UTF-8.
    expect(
      sessionMessageSchema.safeParse({ message: "가".repeat(12_000) }).success,
    ).toBe(false);
    expect(
      sessionMessageSchema.safeParse({ message: "a".repeat(32_768) }).success,
    ).toBe(true);
    expect(unassignedSessionSignalSchema.parse(undefined)).toBeUndefined();
    expect(
      unassignedSessionSignalSchema.safeParse({ session_id: "leaks" }).success,
    ).toBe(false);
  });
});

describe("receipt and error contracts", () => {
  test("uses the design status and error code vocabularies", () => {
    expect(RECEIPT_STATUS_VALUES).toEqual([
      "accepted",
      "succeeded",
      "failed",
      "unknown",
    ]);
    for (const code of [
      "IDEMPOTENCY_CONFLICT",
      "REQUEST_EXPIRED",
      "REQUEST_STALE",
      "SESSION_PAUSED",
      "SESSION_RESUMING",
      "SESSION_CLOSED",
      "SESSION_STOPPED",
      "RECOVERY_REQUIRED",
      "CHECKPOINT_UNAVAILABLE",
      "PAUSE_COMMITTING",
      "PAUSE_CANCELLED",
      "CONTROL_SUPERSEDED",
      "BACKEND_UNAVAILABLE",
      "NOT_READY",
      "CURSOR_EXPIRED",
      "REQUEST_TIMEOUT",
    ]) {
      expect(API_ERROR_CODE_VALUES as readonly string[]).toContain(code);
    }
    expect(
      apiErrorResponseSchema.parse({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "Payload differs from the first accepted request",
          retryable: false,
          request_id: "req_01",
          details: null,
        },
      }).error.code,
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      apiErrorResponseSchema.safeParse({
        error: { code: "not_found", message: "x" },
      }).success,
    ).toBe(false);
    expect(
      receiptSchema.safeParse({
        id: RECEIPT_ID,
        operation: "pause",
        target_ref: { session_id: SESSION_ID, turn_id: null, request_id: null },
        status: "failed",
        result: null,
        error: { code: "PAUSE_CANCELLED", message: "Resume cancelled pause" },
        created_at: AT,
        updated_at: AT,
      }).success,
    ).toBe(true);
  });
});

describe("answers, pending requests and control", () => {
  test("accepts api.md typed answers and rejects the legacy shape", () => {
    expect(
      postSessionAnswerRequestSchema.parse({
        request_id: "perm_01",
        kind: "permission",
        decision: "deny",
        reason: "Not in this repository",
      }).kind,
    ).toBe("permission");
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "q_01",
        kind: "question",
        answers: [
          { question_id: "single", selected_option_ids: ["a"] },
          { question_id: "free", selected_option_ids: [], free_text: "typed" },
        ],
      }).success,
    ).toBe(true);
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "q_02",
        kind: "question",
        answers: [
          { question_id: "dup", selected_option_ids: ["a"] },
          { question_id: "dup", selected_option_ids: ["b"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "q_03",
        kind: "question",
        answers: [{ question_id: "empty", selected_option_ids: [] }],
      }).success,
    ).toBe(false);
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "perm_02",
        answer: { kind: "permission", behavior: "allow" },
      }).success,
    ).toBe(false);
    // A denial reason is optional.
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "perm_03",
        kind: "permission",
        decision: "deny",
      }).success,
    ).toBe(true);
  });

  test("types pending requests by kind", () => {
    const base = {
      request_id: "req_01",
      turn_id: "1",
      attempt_id: "a1",
      created_at: AT,
      expires_at: AT,
    };
    expect(
      pendingRequestSchema.safeParse({
        ...base,
        kind: "permission",
        tool: "Bash",
        input: { command: "pwd" },
      }).success,
    ).toBe(true);
    expect(
      pendingRequestSchema.safeParse({
        ...base,
        kind: "question",
        questions: [
          {
            question_id: "q1",
            prompt: "Which one?",
            options: [{ option_id: "a", label: "A" }],
            multi_select: false,
            allow_free_text: true,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      pendingRequestSchema.safeParse({ ...base, kind: "question" }).success,
    ).toBe(false);
  });

  test("a context gap is visible on the detail, and start_fresh takes no target", () => {
    // a session held back because no checkpoint covers the turns
    // that ran says which ones, and a reset stays visible afterwards.
    const base = {
      id: SESSION_ID,
      title: null,
      revision: 3,
      admission_state: "recovery_required",
      status: "failed",
      runtime: {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        connection_id: "fake-messages",
        model: "claude-sonnet-5",
        permission_mode: "default",
      },
      model: "claude-sonnet-5",
      repository_id: "sample-app",
      current_turn_id: null,
      queued_turn_count: 1,
      last_event_at: AT,
      execution: null,
      checkpoint_revision: null,
      pending_request_count: 0,
      created_at: AT,
      updated_at: AT,
    };
    const durability = {
      last_transcript_persisted_at: null,
      checkpoint_committed_at: null,
      checkpoint_revision: null,
      last_completed_turn_id: "1",
      last_checkpointed_turn_id: null,
      checkpoint_pending_reason: null,
      checkpoint_fallback_revision: null,
    };
    const held = getSessionResponseSchema.parse({
      ...base,
      attention: {
        code: "CONTEXT_GAP",
        last_ran_turn_id: "1",
        checkpointed_turn_id: null,
      },
      durability: { ...durability, context_reset_turn_id: null },
    });
    expect(held.attention).toEqual({
      code: "CONTEXT_GAP",
      last_ran_turn_id: "1",
      checkpointed_turn_id: null,
    });
    expect(
      getSessionResponseSchema.safeParse({
        ...base,
        attention: { code: "CONTEXT_GAP", checkpointed_turn_id: null },
        durability: { ...durability, context_reset_turn_id: null },
      }).success,
    ).toBe(false);
    // Required, not optional: a reader must be able to tell "never reset"
    // from a server that does not report it.
    expect(
      getSessionResponseSchema.safeParse({
        ...base,
        attention: null,
        durability,
      }).success,
    ).toBe(false);
    expect(
      getSessionResponseSchema.parse({
        ...base,
        admission_state: "active",
        status: "idle",
        attention: null,
        durability: { ...durability, context_reset_turn_id: "1" },
      }).durability.context_reset_turn_id,
    ).toBe("1");

    const decision = { expected_revision: 3, reason: "accept the loss" };
    expect(
      recoveryDecisionRequestSchema.safeParse({
        ...decision,
        decision: "start_fresh",
      }).success,
    ).toBe(true);
    expect(
      recoveryDecisionRequestSchema.safeParse({
        ...decision,
        decision: "start_fresh",
        target_turn_id: "1",
      }).success,
    ).toBe(false);
  });

  test("requires evidence for confirm_completed and a target unless closing", () => {
    const base = { expected_revision: 12, reason: "operator checked" };
    expect(
      recoveryDecisionRequestSchema.safeParse({ ...base, decision: "close" })
        .success,
    ).toBe(true);
    expect(
      recoveryDecisionRequestSchema.safeParse({ ...base, decision: "abandon" })
        .success,
    ).toBe(false);
    expect(
      recoveryDecisionRequestSchema.safeParse({
        ...base,
        decision: "confirm_completed",
        target_turn_id: "3",
      }).success,
    ).toBe(false);
    expect(
      recoveryDecisionRequestSchema.safeParse({
        ...base,
        decision: "confirm_completed",
        target_turn_id: "3",
        evidence_ref: "s3://audit/3",
      }).success,
    ).toBe(true);
  });
});

describe("event contracts", () => {
  const eventData = {
    system: { type: "system" },
    assistant: { type: "assistant", message: { content: [] } },
    tool_use: { type: "assistant", message: { content: [] } },
    tool_result: { type: "tool_result" },
    question: {
      request_id: "q_01",
      tool_use_id: "toolu_01",
      kind: "permission",
      tool: "Bash",
      input: { command: "pwd" },
    },
    result: { type: "result", subtype: "success", session_id: "sdk-session" },
    status: { phase: "running" },
    error: { message: "Worker disconnected" },
  } as const;

  test("uses opaque cursors and supports every documented event kind", () => {
    expect(opaqueCursorSchema.parse("ev_01J8X2K4M9")).toBe("ev_01J8X2K4M9");
    expect(opaqueCursorSchema.safeParse("").success).toBe(false);
    expect(Object.keys(eventData)).toEqual([...SESSION_EVENT_NAMES]);
    for (const [event, data] of Object.entries(eventData)) {
      expect(
        sessionEventSchema.safeParse({ id: `ev_${event}`, event, data })
          .success,
      ).toBe(true);
    }
  });

  test("wraps SSE frames in the versioned envelope", () => {
    const frame = sseEventSchema.parse({
      id: "ev_1",
      event: "status",
      data: {
        schema_version: 1,
        session_id: SESSION_ID,
        turn_id: "1",
        attempt_id: "a1",
        occurred_at: AT,
        data: { phase: "needs_input" },
      },
    });
    expect(Object.keys(frame.data)).toEqual([
      "schema_version",
      "session_id",
      "turn_id",
      "attempt_id",
      "occurred_at",
      "data",
    ]);
    expect(
      sseEventSchema.safeParse({
        id: "ev_1",
        event: "status",
        data: { phase: "needs_input" },
      }).success,
    ).toBe(false);
  });
});

describe("worker protocol", () => {
  const scope = {
    session_id: SESSION_ID,
    turn_id: "1",
    attempt_id: "a1",
    lease_epoch: 4,
    execution_generation: 2,
    auth_revision: 1,
  };

  test("a heartbeat answer carries the lease as time remaining on the database clock", () => {
    const answer = {
      lease_expires_at: AT,
      lease_remaining_ms: 120_000,
      auth_revision: 1,
      control_pending: false,
    };
    expect(heartbeatResponseSchema.parse(answer)).toEqual(answer);
    const { lease_remaining_ms: _r, ...withoutRemaining } = answer;
    expect(heartbeatResponseSchema.safeParse(withoutRemaining).success).toBe(
      false,
    );
    for (const lease_remaining_ms of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(
        heartbeatResponseSchema.safeParse({ ...answer, lease_remaining_ms })
          .success,
      ).toBe(false);
    }
  });

  test("a heartbeat answer is taken with or without auth_revision", () => {
    const fromOldServer = {
      lease_expires_at: AT,
      lease_remaining_ms: 120_000,
      auth_revision: 1,
      control_pending: false,
    };
    const { auth_revision: _a, ...fromNewServer } = fromOldServer;
    expect(heartbeatResponseSchema.parse(fromOldServer)).toEqual(fromOldServer);
    expect(heartbeatResponseSchema.parse(fromNewServer)).toEqual(fromNewServer);
  });

  test("an append-events request is taken with or without batch_key", () => {
    const request = {
      ...scope,
      events: [
        {
          source_sequence: 1,
          occurred_at: AT,
          event: "status",
          data: { phase: "running" },
        },
      ],
    };
    const parsed = appendEventsRequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("batch_key");
    expect(
      appendEventsRequestSchema.parse({ ...request, batch_key: "a1:1-1" })
        .batch_key,
    ).toBe("a1:1-1");
    expect(
      appendEventsRequestSchema.safeParse({ ...request, batch_key: "" })
        .success,
    ).toBe(false);
  });

  test("a settlement says why a request was cancelled and what the run made of an answer", () => {
    const poll = (settled: unknown[]) =>
      pendingControlRequestSchema.safeParse({
        ...scope,
        answers_after: 0,
        settled,
      }).success;
    const id = "req_01";
    // An older worker's settlement, unchanged.
    expect(poll([{ request_id: id, outcome: "cancelled" }])).toBe(true);
    for (const reason of ["park", "shutdown", "interrupt", "refused"]) {
      expect(poll([{ request_id: id, outcome: "cancelled", reason }])).toBe(
        true,
      );
      expect(poll([{ request_id: id, outcome: "answered", reason }])).toBe(
        false,
      );
    }
    // An expiry is its own outcome.
    expect(
      poll([{ request_id: id, outcome: "cancelled", reason: "expired" }]),
    ).toBe(false);
    for (const answer_result of ["applied", "unknown"]) {
      expect(
        poll([{ request_id: id, outcome: "answered", answer_result }]),
      ).toBe(true);
      expect(
        poll([{ request_id: id, outcome: "cancelled", answer_result }]),
      ).toBe(false);
    }
    expect(
      poll([{ request_id: id, outcome: "cancelled", answer_result: "stale" }]),
    ).toBe(true);
    expect(
      poll([{ request_id: id, outcome: "answered", answer_result: "stale" }]),
    ).toBe(false);
    // An expiry delivered nothing, so the run said nothing of an answer.
    for (const answer_result of ["applied", "unknown", "stale"]) {
      expect(
        poll([{ request_id: id, outcome: "expired", answer_result }]),
      ).toBe(false);
    }
    expect(poll([{ request_id: id, outcome: "expired", reason: "park" }])).toBe(
      false,
    );
  });

  test("fences every post-claim request with the same identity", () => {
    expect(workerScopeSchema.parse(scope)).toEqual(scope);
    expect(nextInputRequestSchema.safeParse(scope).success).toBe(true);
    expect(
      heartbeatRequestSchema.safeParse({ ...scope, attempt_state: "running" })
        .success,
    ).toBe(true);
    expect(
      pendingControlRequestSchema.safeParse({ ...scope, answers_after: 0 })
        .success,
    ).toBe(true);
    expect(
      pendingControlResponseSchema.parse({
        control: null,
        answers: [
          {
            sequence: 1,
            answer: {
              request_id: "perm_01",
              kind: "permission",
              decision: "allow",
            },
            input_hash: "a".repeat(64),
          },
        ],
      }).answers[0]?.sequence,
    ).toBe(1);
    expect(
      finalizeResponseSchema.safeParse({
        turn_id: "1",
        status: "running",
        checkpoint_revision: null,
      }).success,
    ).toBe(false);
    expect(
      releaseRequestSchema.safeParse({ ...scope, reason: "drain" }).success,
    ).toBe(true);
    expect(
      appendEventsRequestSchema.safeParse({
        ...scope,
        batch_key: "b1",
        events: [
          {
            source_sequence: 1,
            occurred_at: AT,
            event: "status",
            data: { phase: "running" },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      finalizeRequestSchema.safeParse({
        ...scope,
        finalize_key: "f1",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: { ok: true },
          usage: null,
        },
        checkpoint: {
          revision: 4,
          manifest_ref: "s3://bucket/manifest",
          manifest_sha256: "a".repeat(64),
        },
      }).success,
    ).toBe(true);
    expect(
      finalizeRequestSchema.safeParse({
        ...scope,
        finalize_key: "f1",
        final_source_sequence: 0,
        terminal: { status: "queued", reason: null, result: null, usage: null },
        checkpoint: null,
      }).success,
    ).toBe(false);
    const { lease_epoch, ...unfenced } = scope;
    expect(lease_epoch).toBe(4);
    expect(nextInputRequestSchema.safeParse(unfenced).success).toBe(false);
  });

  test("binds bootstrap claims to a launch nonce or workload identity", () => {
    expect(
      bootstrapClaimRequestSchema.safeParse({
        execution_id: "exec_1",
        execution_generation: 2,
        credential: { kind: "launch_nonce", nonce: "one-time" },
      }).success,
    ).toBe(true);
    const claim = {
      ...scope,
      session_credential: "wsc_token",
      lease_expires_at: AT,
      lease_remaining_ms: 120_000,
      runtime: {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        connection_id: "fake-messages",
        permission_mode: "default",
      },
      spec_digest: `sha256:${"b".repeat(64)}`,
      runtime_config: {
        model: "claude-sonnet-5",
        tools: ["Read", "Edit"],
        permission_mode: "default",
        provider: {
          kind: "litellm",
          endpoint: "https://litellm.invalid",
          auth: { kind: "egress_token", token: "wep_provider" },
        },
        project_settings: { claude_md: true },
      },
      workspace: {
        repository: {
          id: "sample-app",
          url: "https://example.invalid/team/app.git",
          branch: "main",
          access: { kind: "egress_token", token: "wer_repository" },
        },
      },
      object_store: {
        access: { kind: "egress_token", token: "object-store-token" },
      },
      principal: { owner_scope: "owner_1" },
      restore: null,
      remaining_budget_usd: 12.5,
    };
    expect(bootstrapClaimResponseSchema.safeParse(claim).success).toBe(true);
    const oldWorker = bootstrapClaimResponseSchema.omit({
      workspace_enforce: true,
    });
    for (const workspace_enforce of ["warn", "fail", "off"] as const) {
      expect(
        bootstrapClaimResponseSchema.parse({ ...claim, workspace_enforce })
          .workspace_enforce,
      ).toBe(workspace_enforce);
      expect(
        oldWorker.parse({ ...claim, workspace_enforce }),
      ).not.toHaveProperty("workspace_enforce");
    }
    expect(
      bootstrapClaimResponseSchema.parse(claim).workspace_enforce,
    ).toBeUndefined();
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...claim,
        workspace_enforce: "force",
      }).success,
    ).toBe(false);
    // Only the public summary may lack a runtime; a claim always has one.
    expect(
      bootstrapClaimResponseSchema.safeParse({ ...claim, runtime: null })
        .success,
    ).toBe(false);
    // The engine's budget is what is left of the session's, never below
    // nothing and never left out.
    const { remaining_budget_usd: _b, ...withoutBudget } = claim;
    expect(bootstrapClaimResponseSchema.safeParse(withoutBudget).success).toBe(
      false,
    );
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...claim,
        remaining_budget_usd: -0.01,
      }).success,
    ).toBe(false);
    // A claim without the workspace or the resolved config is not a claim a
    // worker can act on.
    const { workspace: _w, ...withoutWorkspace } = claim;
    expect(
      bootstrapClaimResponseSchema.safeParse(withoutWorkspace).success,
    ).toBe(false);
    const { runtime_config: _p, ...withoutConfig } = claim;
    expect(bootstrapClaimResponseSchema.safeParse(withoutConfig).success).toBe(
      false,
    );
    // The digest names the exact spec the claim resolved.
    // The lease a worker tracks is the remaining time, not the deadline
    // a claim without it could only be judged by a wall clock.
    const { lease_remaining_ms: _r, ...withoutRemaining } = claim;
    expect(
      bootstrapClaimResponseSchema.safeParse(withoutRemaining).success,
    ).toBe(false);
    const { spec_digest: _f, ...withoutFingerprint } = claim;
    expect(
      bootstrapClaimResponseSchema.safeParse(withoutFingerprint).success,
    ).toBe(false);
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...claim,
        spec_digest: "b".repeat(64),
      }).success,
    ).toBe(false);
    // A claim from a gateway that predates the field lets nothing in; a
    // hooks switch does not exist to be sent.
    const { project_settings: _s, ...withoutProjectSettings } =
      claim.runtime_config;
    const legacy = bootstrapClaimResponseSchema.parse({
      ...claim,
      runtime_config: withoutProjectSettings,
    });
    expect(legacy.runtime_config.project_settings).toBeUndefined();
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...claim,
        runtime_config: {
          ...claim.runtime_config,
          project_settings: { claude_md: true, hooks: true },
        },
      }).success,
    ).toBe(false);
    // Legacy rows carry no catalog key but still name a repository.
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...claim,
        workspace: { repository: { ...claim.workspace.repository, id: null } },
      }).success,
    ).toBe(true);
    // A session accepted without a repository names none at all.
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...claim,
        workspace: { repository: null },
      }).success,
    ).toBe(true);
    expect(
      bootstrapClaimResponseSchema.safeParse({ ...claim, workspace: {} })
        .success,
    ).toBe(false);
    // A repository reached without the proxy (a local path in tests) has no
    // token to carry.
    const { access: _a, ...withoutAccess } = claim.workspace.repository;
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...claim,
        workspace: { repository: withoutAccess },
      }).success,
    ).toBe(true);
    // The upstream credential itself is refused in every shape it used to
    // take: the worker is only ever handed the proxy's token.
    for (const kind of ["anthropic", "litellm"] as const) {
      for (const auth of [
        { kind: "api_key", value: "provider-key" },
        { kind: "bearer", value: "provider-key" },
        { kind: "egress_token", token: "wep_x", value: "provider-key" },
      ]) {
        expect(
          bootstrapClaimResponseSchema.safeParse({
            ...claim,
            runtime_config: {
              ...claim.runtime_config,
              provider: {
                kind,
                endpoint: "https://api.anthropic.invalid",
                auth,
              },
            },
          }).success,
        ).toBe(false);
      }
    }
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...claim,
        workspace: {
          repository: {
            ...claim.workspace.repository,
            access: { kind: "basic", username: "bot", value: "repo-token" },
          },
        },
      }).success,
    ).toBe(false);
  });

  test("a checkpoint and a restore plan name object versions, never the replaceable null one", () => {
    const scope = {
      session_id: SESSION_ID,
      turn_id: "1",
      attempt_id: "att_1",
      lease_epoch: 1,
      execution_generation: 1,
      auth_revision: 1,
    };
    const finalize = (manifest_version?: string) =>
      finalizeRequestSchema.safeParse({
        ...scope,
        finalize_key: "f1",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: {
          revision: 0,
          manifest_ref: "sessions/s/checkpoints/0/a/manifest.json",
          manifest_sha256: "a".repeat(64),
          ...(manifest_version === undefined ? {} : { manifest_version }),
        },
      }).success;
    expect(finalize("3sL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY")).toBe(true);
    expect(finalize()).toBe(true);
    expect(finalize("null")).toBe(false);
    expect(finalize("")).toBe(false);
    // Opaque UTF-8 up to 1024 bytes, counted in bytes.
    expect(finalize("버전 🙂")).toBe(true);
    expect(finalize("x".repeat(1024))).toBe(true);
    expect(finalize("한".repeat(342))).toBe(false);

    const part = {
      key: "sessions/s/mirror/part-0.jsonl",
      bytes: 3,
      sha256: "b".repeat(64),
    };
    const plan = (version: string | undefined) =>
      restorePlanResponseSchema.parse({
        status: "ready",
        plan: {
          revision: 0,
          manifest_ref: "sessions/s/checkpoints/0/a/manifest.json",
          manifest_sha256: "a".repeat(64),
          manifest_version: "m1",
          engine: "claude",
          resume: "sdk-session",
          cwd: "/workspace",
          git_commit: "0".repeat(40),
          artifacts: [
            {
              kind: "transcript_root",
              label: "",
              objects: [version === undefined ? part : { ...part, version }],
            },
          ],
          object_keys: [part.key],
        },
      });
    expect(plan("v1")).toMatchObject({
      plan: {
        manifest_version: "m1",
        artifacts: [{ objects: [{ version: "v1" }] }],
      },
    });
    expect(plan(undefined)).toMatchObject({ status: "ready" });
    expect(() => plan("null")).toThrow();
  });

  test("a restore plan says when it falls back to an earlier revision, and names what it skipped", () => {
    const plan = (fallback: unknown) =>
      restorePlanResponseSchema.safeParse({
        status: "ready",
        plan: {
          revision: 0,
          manifest_ref: "sessions/s/checkpoints/0/a/manifest.json",
          manifest_sha256: "a".repeat(64),
          engine: "claude",
          resume: "sdk-session",
          cwd: "/workspace",
          git_commit: "0".repeat(40),
          artifacts: [],
          object_keys: [],
          ...(fallback === undefined ? {} : { fallback }),
        },
      });
    expect(
      plan({
        pointer_revision: 2,
        skipped: [
          { revision: 2, reason: "manifest object is missing" },
          { revision: 1, reason: "digest mismatch" },
        ],
      }).success,
    ).toBe(true);
    expect(plan(undefined).success).toBe(true);
    // A fallback that skipped nothing is not a fallback.
    expect(plan({ pointer_revision: 1, skipped: [] }).success).toBe(false);
    expect(
      plan({ pointer_revision: 1, skipped: [{ revision: 1, reason: "" }] })
        .success,
    ).toBe(false);
  });
});
